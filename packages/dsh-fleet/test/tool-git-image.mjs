/**
 * The three tools the previous plugin could not run remotely at all: `git`,
 * `read_image`, and `grep` over a real repository.
 *
 * `@artenx/dshb` mirrored a remote directory into a local one, so:
 *
 *   - `git` ran against the local mirror, where `.git` was either absent or a
 *     different repository — `fatal: not a git repository`, or worse, a correct
 *     answer about the wrong repo;
 *   - `read_image` decoded bytes from a local path that only existed on the node,
 *     so a remote screenshot never opened;
 *   - `grep`/`glob` walked the mirror, missing anything the mirror skipped.
 *
 * With the brain on the node all three are the node's own tools. This test sets up
 * a real git repository and a real PNG on the node, asks a remote Session to use
 * them, and audits the transcript.
 *
 * Usage: node test/tool-git-image.mjs <hostBase> <launchToken>
 */
import { Client } from 'ssh2'
import { nodeConfig } from './node.mjs'
import { authenticate, call as rawCall, liveStream, openCarrier } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/tool-git-image.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const NODE = nodeConfig()

const log = message => process.stderr.write(`[tool-git-image] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function nodeExec(command) {
  const client = new Client()
  await new Promise((resolve, reject) => {
    client.on('ready', resolve).on('error', reject).connect({ ...NODE, readyTimeout: 20_000 })
  })
  try {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error)
        const out = []
        stream.on('data', chunk => out.push(chunk))
        stream.on('close', () => resolve(Buffer.concat(out).toString('utf8')))
      })
    })
  } finally {
    client.end()
  }
}

const cookie = await authenticate(base, token)
const call = (endpoint, args) => rawCall(base, cookie, endpoint, args)
const carrier = await openCarrier({ base, cookie })

const wsStream = liveStream(carrier, 'workspace/follow', {})
for (let attempt = 0; attempt < 100 && wsStream.frames.length === 0; attempt += 1) await sleep(150)
const items = wsStream.frames.find(frame => frame.value?.type === 'baseline')?.value?.value?.items ?? []
wsStream.stop()
const remoteWorkspace = items.find(item => String(item.workspaceId).startsWith('fleet_'))
check(remoteWorkspace !== undefined, 'a remote workspace is available', remoteWorkspace?.path)
if (remoteWorkspace === undefined) { carrier.close(); process.exit(1) }
const root = remoteWorkspace.path

// ---- a real git repository and a real PNG, both only on the node ---------
const repo = `${root}/git-image`
// A verified 4x4 solid-red RGBA PNG. (Hand-written base64 is easy to get wrong:
// a bad IDAT checksum makes `read_image` fail for a reason that has nothing to do
// with routing, which would hide the thing this test actually checks.)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC'
await nodeExec([
  `rm -rf ${repo}`,
  `mkdir -p ${repo}`,
  `cd ${repo} && git init -q`,
  `cd ${repo} && git config user.email t@t && git config user.name T`,
  `cd ${repo} && printf 'module.exports = 1\\n' > index.js`,
  `cd ${repo} && git add -A && git commit -qm "initial commit"`,
  `echo '${png}' | base64 -d > ${repo}/pixel.png`,
].join(' && '))
const gitLog = await nodeExec(`cd ${repo} && git log --oneline | head -3`)
check(gitLog.includes('initial commit'), 'the node really has a git repository', gitLog.trim())

// ---- drive a remote Session --------------------------------------------
const created = await call('session/create', { request: { workspaceId: remoteWorkspace.workspaceId } })
const sessionId = created?.sessionId
check(typeof sessionId === 'string', 'a remote session was created', sessionId)
if (sessionId === undefined) { carrier.close(); process.exit(1) }

const follow = liveStream(carrier, 'session/follow', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 128 },
})
await sleep(2_000)

const prompt = `在 ${repo} 里用对应的专门工具做下面四件事，不要全部用 bash 兜底：

1. 用 \`bash\` 在 ${repo} 里跑 \`git log --oneline\` 和 \`git status --short\`，把真实输出贴回来。
2. 用 \`read_image\` 读取 ${repo}/pixel.png，说明它是什么颜色、多大。
3. 用 \`grep\` 在 ${repo} 里搜索 "module.exports"，给出命中位置。
4. 用 \`bash\` 跑 \`git rev-parse --show-toplevel\` 确认仓库根目录在哪。

每一步都要真的调用对应工具，最后汇总每步的真实输出。`

await call('session/prompt', {
  request: {
    sessionId,
    requestId: `tgi-${Date.now()}`,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  },
})
log('task sent; waiting for the turn to finish')

let done = false
const deadline = Date.now() + 420_000
while (Date.now() < deadline && !done) {
  await sleep(2_000)
  done = follow.frames.some(frame => frame.value?.event?.type === 'turn/end')
}
follow.stop()
check(done, 'the turn completed', `${String(follow.frames.length)} frames`)
await sleep(1_000)

// ---- audit ---------------------------------------------------------------
const page = await call('session/page', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 256 },
})
const events = (page?.records ?? []).map(record => record?.event).filter(Boolean)
const calls = new Map()
for (const event of events) {
  if (event.type === 'tool/call') {
    const data = event.data ?? {}
    calls.set(data.callId ?? event.seq, { name: data.name, args: data.arguments, result: undefined, isError: undefined })
  } else if (event.type === 'tool/result') {
    const message = event.data?.message ?? {}
    const callId = message.toolCallId ?? event.data?.toolCallId
    const existing = calls.get(callId)
    if (existing === undefined) continue
    existing.result = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
    existing.isError = message.isError === true
  }
}
const toolList = [...calls.values()]
log(`tools used: ${toolList.map(tool => tool.name).join(', ') || '(none)'}`)
for (const tool of toolList) {
  log(`  ${tool.name}${tool.isError === true ? ' [ERROR]' : ''}: ${String(tool.result ?? '').replaceAll('\n', ' ⏎ ').slice(0, 130)}`)
}

// git must be reported as a real repository whose root is the node path.
const bashResults = toolList.filter(tool => tool.name === 'bash').map(tool => String(tool.result ?? ''))
const allBash = bashResults.join('\n')
check(allBash.includes(repo), '`git` ran inside the node repository directory', repo)
check(/[0-9a-f]{7} initial commit|initial commit/u.test(allBash),
  '`git log` returned the node commit')
check(!/not a git repository/iu.test(allBash), '`git` did not complain about a missing repository')

// read_image must have decoded the node's PNG.
const imageTool = toolList.find(tool => tool.name === 'read_image' || tool.name === 'readImage')
check(imageTool !== undefined, 'the agent has a `read_image` tool')
if (imageTool !== undefined) {
  check(imageTool.isError !== true, '`read_image` succeeded on the node file',
    String(imageTool.result ?? '').slice(0, 120))
  check(!/ENOENT|no such file|不存在/iu.test(String(imageTool.result ?? '')),
    '`read_image` did not fail on a path')
}

// grep must have hit the node's file.
const grepTool = toolList.find(tool => tool.name === 'grep')
check(grepTool !== undefined && grepTool.isError !== true, '`grep` succeeded on the node files',
  String(grepTool?.result ?? '').slice(0, 120))

// Nothing may reference a Windows path. Two separate checks, because a raw
// `[A-Za-z]:\\` regex is useless here: agent-written code contains escapes like
// `except Exception as e:\n`, and `e:\` looks exactly like a drive root.
const mirrorSignature = toolList.filter(tool => {
  const text = `${String(tool.args ?? '')}${String(tool.result ?? '')}`
  return /dshb[\\/]mirrors|\.dsh[\\/]dshb|[A-Za-z]:[\\/]+Users[\\/]/u.test(text)
})
check(mirrorSignature.length === 0, 'no tool call touches the old mirror directory',
  mirrorSignature.map(tool => String(tool.args ?? tool.result).slice(0, 80)).join(' | ') || 'none')

// A real drive path has at least a directory component after the root.
const windowsPaths = toolList.filter(tool => {
  const text = `${String(tool.args ?? '')}${String(tool.result ?? '')}`
  return /[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.\-]+[\\/]{1,2}/u.test(text)
})
check(windowsPaths.length === 0, 'no tool call mentions a real Windows path',
  windowsPaths.map(tool => String(tool.args ?? tool.result).slice(0, 80)).join(' | ') || 'none')

carrier.close()
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
await sleep(250)
process.exit(process.exitCode ?? 0)
