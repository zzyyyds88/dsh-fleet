/**
 * Drive a real DSH session the way a person does, then judge the result from the
 * node's own logs — the acceptance the user asked for.
 *
 * Every other test in this directory asks "is the wiring there". This one asks the
 * only question that matters to somebody using the product:
 *
 *   1. pick a **remote** workspace and open a real Session in it;
 *   2. send an ordinary prompt through the same `session/prompt` endpoint the
 *      composer uses;
 *   3. wait for the node's agent to finish, and read its `session/follow` stream;
 *   4. assert the tool calls the prompt implies actually happened **on the node**,
 *      with the values the prompt asked for;
 *   5. read the artefacts back over a **separate SSH connection**, so the plugin's
 *      own report is not the only witness.
 *
 * That last step is the difference between "the endpoint returned 200" and "the
 * remote brain really ran the tool". Both matter; only one is evidence.
 *
 * Real event shapes this test relies on (read out of a live node, not guessed):
 *
 *   - `tool/call`         `{ turn, step, callId, name, arguments }` — `arguments` is a JSON string
 *   - `tool/result`       `{ message: { content: [{type:'text',text}], isError }, meta: { cwd } }`
 *   - `assistant/message` `{ message: { content: [{type:'text',text}, {type:'tool-call',…}] } }`
 *   - `turn/end`          `{ turn, reason: { kind } }`
 *
 * Run:
 *   DSH_FLEET_TEST_HOST=… DSH_FLEET_TEST_USER=… DSH_FLEET_TEST_PASSWORD=… \
 *   node test/session-acceptance.mjs <hostBase> <launchToken>
 */
import { nodeExec } from './node.mjs'
import { authenticate, call, liveStream, openCarrier } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node session-acceptance.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stdout.write(`[session-acceptance] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = Date.now().toString(36)

const cookie = await authenticate(base, token)

// ---- 1. the sidebar has to offer a remote workspace at all ----------------
const carrier = await openCarrier({ base, cookie })
const follow = liveStream(carrier, 'workspace/follow', {})
const deadline = Date.now() + 20_000
let rows = []
while (Date.now() < deadline) {
  const baseline = follow.frames.find(frame => frame.value?.type === 'baseline')
  rows = baseline?.value?.value?.items ?? []
  if (rows.length > 0) break
  await sleep(300)
}
follow.stop()
check(rows.length > 0, 'the workspace stream answered with a baseline', `${String(rows.length)} rows`)

const remote = rows.find(row => String(row.workspaceId).startsWith('fleet_'))
check(remote !== undefined, 'a remote workspace is present in the ordinary sidebar list',
  remote === undefined ? rows.map(row => row.title).join(',') : `${remote.title} (${remote.path})`)
if (remote === undefined) {
  carrier.close()
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
  process.exit(failures.length === 0 ? 0 : 1)
}

// ---- 2. open a real Session in it, exactly like clicking "New session" -----
const created = await call(base, cookie, 'session/create', {
  request: { workspaceId: remote.workspaceId },
})
const sessionId = created.sessionId
check(typeof sessionId === 'string' && sessionId.startsWith('fleet_'),
  'a new Session in a remote workspace gets a wrapped identity', sessionId)

const bare = String(sessionId).split('_').slice(2).join('_')

// ---- 3. follow it, then send the prompt a person would send --------------
const followCarrier = await openCarrier({ base, cookie })
const session = liveStream(followCarrier, 'session/follow', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 400 },
})
// The opening snapshot is the Session's own header — the only place `create`
// reports a working directory, because upstream's create value carries just the id.
// (A `session/follow` frame is `{type:'item', value:{type:'snapshot', header, …}}`.)
const openedAt = Date.now() + 15_000
let header
while (Date.now() < openedAt && header === undefined) {
  await sleep(200)
  header = session.frames
    .flatMap(frame => (frame.value?.type === 'snapshot' ? [frame.value.header] : []))
    .find(value => value !== undefined)
}
check(header !== undefined, 'the remote Session answered with its own header', header?.id?.slice(0, 44))
check(String(header?.cwd ?? '').startsWith(remote.path),
  'and its working directory is the node path, not a local mirror', header?.cwd)

const file = `acceptance-${stamp}.txt`
const payload = `ACCEPTANCE_${stamp}`
const prompt = [
  `在 ${remote.path} 下做三件事，每件都用工具真做，不要只用文字回答：`,
  `1. 用 write 工具创建 ${file}，内容只有一行：${payload}`,
  `2. 用 bash 或 pwsh 工具运行 \`wc -c < ${file}\` 并把输出原样贴给我`,
  `3. 用 grep 工具在 ${file} 里搜 ${payload}`,
  '最后一行只回复 DONE。',
].join('\n')

const promptedAt = Date.now()
await call(base, cookie, 'session/prompt', {
  request: {
    sessionId,
    requestId: `acc-${stamp}`,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  },
})
log(`prompt sent to the remote Session ${String(sessionId).slice(0, 40)}…`)

// ---- 4. wait for the agent to finish, then read what it actually did -----
const finished = Date.now() + 240_000
const eventsOf = () => session.frames
  .flatMap(frame => (frame.value?.type === 'event' ? [frame.value.event] : []))
let events = []
while (Date.now() < finished) {
  await sleep(2_000)
  events = eventsOf()
  if (events.some(event => event?.type === 'turn/end')) break
}
log(`collected ${String(events.length)} Session events`)

const toolCalls = events
  .filter(event => event?.type === 'tool/call')
  .map(event => ({ name: String(event.data?.name ?? ''), arguments: String(event.data?.arguments ?? '') }))
const toolResults = events
  .filter(event => event?.type === 'tool/result')
  .map(event => (event.data?.message?.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n'))
const assistantTexts = events
  .filter(event => event?.type === 'assistant/message')
  .flatMap(event => (event.data?.message?.content ?? []))
  .filter(block => block?.type === 'text')
  .map(block => String(block.text ?? ''))

check(toolCalls.length > 0, 'the remote agent really called tools', `${String(toolCalls.length)} call(s)`)
const names = toolCalls.map(call => call.name)
check(names.some(name => /write|edit|fs/i.test(name)), 'one of them writes a file', names.join(','))
check(names.some(name => /bash|shell|pwsh/i.test(name)), 'one of them runs a shell', names.join(','))
check(names.some(name => /grep|search|find/i.test(name)), 'one of them searches', names.join(','))
check(toolResults.length === toolCalls.length, 'every call produced a result',
  `${String(toolResults.length)} of ${String(toolCalls.length)}`)
check(!events.some(event => event?.type === 'tool/result' && event.data?.message?.isError === true),
  'and none of them failed')
check(events.some(event => event?.type === 'turn/end' && event.data?.reason?.kind === 'completed'),
  'the turn ended with `completed`', JSON.stringify(events.find(e => e?.type === 'turn/end')?.data?.reason))
check(assistantTexts.some(text => text.includes('DONE')),
  'the agent said DONE, so the turn completed', JSON.stringify(assistantTexts.at(-1)?.slice(0, 80)))

// ---- 5. independent witness: read the artefact over a fresh SSH link -----
const listed = await nodeExec(`cd ${remote.path} && ls -1 | grep -c '^${file}$' || true`)
check(listed.trim() === '1', `the file exists on the node (${file})`, listed.trim())
const content = await nodeExec(`cd ${remote.path} && cat '${file}'`)
check(content.trim() === payload, 'and its bytes are exactly what the prompt asked for',
  JSON.stringify(content.trim()))
const bytes = await nodeExec(`cd ${remote.path} && wc -c < '${file}'`)
// The `write` tool may or may not terminate the last line, so the byte count is the payload
// length with an optional single trailing newline. Asserting `+ 1` unconditionally made this
// test depend on a formatting choice the prompt never made: measured 19 bytes for a 19-char
// payload in one run, which is correct and used to read as a failure.
const written = Buffer.byteLength(payload, 'utf8')
check(bytes.trim() === String(written) || bytes.trim() === String(written + 1),
  'the file holds the payload and at most a trailing newline',
  `${bytes.trim()} bytes for a ${String(written)}-char payload`)

// The plugin must not have invented the answer: the tool result has to agree with
// what the filesystem says.
check(toolResults.some(result => result.includes(bytes.trim())),
  'the shell tool result carries the byte count the node measured', bytes.trim())
check(toolResults.some(result => result.includes(payload)),
  'the search tool result shows the payload it found')

// ---- 6. the row in the sidebar reflects the turn -------------------------
const listed2 = await call(base, cookie, 'session/list', { _request: {} })
const row = (listed2.items ?? []).find(item => item.sessionId === sessionId)
check(row !== undefined, 'the Session is in the merged list', row?.title)
check(Number(row?.updatedAt ?? 0) > promptedAt,
  'with a timestamp from after the prompt, so the merge is not a stale snapshot',
  `${String(row?.updatedAt)} vs ${String(promptedAt)}`)
check(String(row?.cwd ?? '') === String(remote.path),
  'and a node-side directory', row?.cwd)

// ---- 7. the node really ran it: its own session log names this Session ---
// The node keeps one log directory per Session under a cwd-mangled parent, so the
// check is a find rather than a fixed path. The mangling is DSH's own: `/root/project`
// becomes `--root-project--`, which is what has to be compared — matching a substring of
// the plain path only worked while the workspace happened to be called `grouptest`.
const mangle = path => `--${String(path).replace(/^\//u, '').replaceAll('/', '-')}--`
const nodeLog = await nodeExec(
  `find ~/.dsh/sessions -maxdepth 2 -name 'session-${bare.replace(/^session-/u, '')}' 2>/dev/null | head -1`,
)
check(nodeLog.trim().length > 0, 'the node has a session log for it', nodeLog.trim())
check(nodeLog.includes(mangle(remote.path)),
  'and that log lives under the workspace path the Session reports',
  `${nodeLog.trim()} vs ${mangle(remote.path)}`)

session.stop()
followCarrier.close()
carrier.close()
await sleep(500)
log(`node Session ${bare}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
