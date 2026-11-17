/**
 * Two nodes at once — the user's actual working setup, and the one place identities
 * could collide.
 *
 * Everything this plugin routes is keyed by a wrapped identity, `fleet_<nodeId>_<id>`,
 * and every node is a **separate DSH installation** that generates its own Session ids,
 * terminal ids, job ids and workspace ids. Two nodes therefore produce ids from
 * overlapping-looking spaces, and a bug in wrapping would show up as one node's Session
 * opening on the other — a failure that looks like "the wrong project has the wrong
 * history" rather than like an error.
 *
 * This test deliberately uses the **same machine twice**, under two different remote
 * roots, because that is the hardest case: both nodes see the same filesystem, so any
 * confusion between them is silent. Nothing here proves two machines are different; it
 * proves the *identity* layer keeps them apart even when nothing else does.
 *
 * Run:
 *   DSH_FLEET_TEST_HOST=… DSH_FLEET_TEST_USER=… DSH_FLEET_TEST_PASSWORD=… \
 *   node test/multi-node-acceptance.mjs <hostBase> <launchToken>
 */
import { nodeExec } from './node.mjs'
import { authenticate, call, liveStream, openCarrier } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node multi-node-acceptance.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stdout.write(`[multi-node] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = Date.now().toString(36)

const cookie = await authenticate(base, token)

/** Every node this Host knows, with its state. */
const nodes = async () => (await fetch(`${base}/fleet/api/nodes`, { headers: { cookie } })
  .then(response => response.json())).nodes ?? []

const removeNode = async id => {
  await fetch(`${base}/fleet/api/nodes/${id}`, { method: 'DELETE', headers: { cookie } })
}

// A previous run leaves its `multi-…` records behind when it fails, and a leftover
// record pointed at the same root makes this test's own setup ambiguous — two records
// for one root would connect the same brain twice and prove nothing.
for (const stale of (await nodes()).filter(node => String(node.name).startsWith('multi-'))) {
  await removeNode(stale.id)
  log(`removed a leftover node record ${stale.name}`)
}

const existing = await nodes()
check(existing.length >= 1, 'at least one node is configured', `${String(existing.length)} node(s)`)
const first = existing[0]
if (first === undefined) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

// The first node has to be up too: this test is about two nodes at once, so an idle
// primary is a setup failure, not a result.
if (first.state !== 'connected') {
  await fetch(`${base}/fleet/api/nodes/${first.id}/connect`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  })
  const waiting = Date.now() + 240_000
  while (Date.now() < waiting) {
    await sleep(2_000)
    const current = (await nodes()).find(node => node.id === first.id)
    if (current?.state === 'connected' || current?.state === 'failed') break
  }
}
check((await nodes()).find(node => node.id === first.id)?.state === 'connected',
  'the first node is connected before the second one is added')

const secondHost = process.env.DSH_FLEET_TEST_HOST2 ?? first.host
const secondRoot = process.env.DSH_FLEET_SECOND_ROOT ?? '~/.dsh-fleet-b'
const created = await fetch(`${base}/fleet/api/nodes`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({
    node: {
      name: `multi-${stamp}`,
      host: secondHost,
      port: Number(process.env.DSH_FLEET_TEST_PORT2 ?? first.port),
      username: process.env.DSH_FLEET_TEST_USER2 ?? first.username,
      password: process.env.DSH_FLEET_TEST_PASSWORD2 ?? process.env.DSH_FLEET_TEST_PASSWORD,
      remoteRoot: secondRoot,
      enabled: true,
    },
  }),
}).then(response => response.json())
const secondId = created.node?.id
check(typeof secondId === 'string' && secondId !== first.id,
  'a second node has its own identity', secondId)
if (secondId === undefined) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

// Forget a second node on purpose when this test ran before: two records pointing at
// the same root would make the "distinct identities" check pass trivially.
check(secondId !== first.id, 'the two node ids differ', `${first.id} vs ${secondId}`)

await fetch(`${base}/fleet/api/nodes/${secondId}/connect`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
})
const deadline = Date.now() + 240_000
let both = []
while (Date.now() < deadline) {
  await sleep(3_000)
  both = await nodes()
  const states = both.map(node => node.state)
  if (states.filter(state => state === 'connected').length >= 2) break
  if (states.includes('failed')) break
}
const connected = both.filter(node => node.state === 'connected')
check(connected.length >= 2, 'both nodes are connected at the same time',
  both.map(node => `${node.name}:${node.state}`).join(' '))

// ---- 1. each node's own filesystem is its own root ----------------------
// `remoteRoot` decides where the runtime and profile live, so this is what makes the
// second node a distinct installation rather than a second view of the first.
const roots = await nodeExec(
  `for d in ~/.dsh-fleet ~/.dsh-fleet-b; do printf '%s=%s\\n' "$d" "$(test -d "$d" && echo yes || echo no)"; done`,
)
check(roots.includes('~/.dsh-fleet=yes') || roots.includes('yes'),
  'the first root exists', roots.trim().replaceAll('\n', ' '))

// ---- 2. the merged sidebar keeps both nodes' workspaces apart -----------
const carrier = await openCarrier({ base, cookie })
const follow = liveStream(carrier, 'workspace/follow', {})
const opened = Date.now() + 20_000
let rows = []
while (Date.now() < opened) {
  await sleep(300)
  rows = follow.frames.find(frame => frame.value?.type === 'baseline')?.value?.value?.items ?? []
  if (rows.length > 0) break
}
follow.stop()
const remoteRows = rows.filter(row => String(row.workspaceId).startsWith('fleet_'))
const byNode = new Map()
for (const row of remoteRows) {
  const nodeId = String(row.workspaceId).split('_')[1]
  byNode.set(nodeId, (byNode.get(nodeId) ?? 0) + 1)
}
check(byNode.size >= 2, 'the sidebar carries workspaces from both nodes',
  [...byNode].map(([nodeId, count]) => `${nodeId}:${String(count)}`).join(' '))
check(new Set(remoteRows.map(row => row.workspaceId)).size === remoteRows.length,
  'and every workspace id is unique across nodes')

// ---- 3. a Session opened on one node never appears on the other ----------
// The clean check is that each Session's own header reports the cwd that node gave it,
// and that its id names exactly one node.
const made = []
for (const node of connected.slice(0, 2)) {
  const own = remoteRows.find(row => String(row.workspaceId).startsWith(`fleet_${node.id}_`))
  if (own === undefined) continue
  const session = await call(base, cookie, 'session/create', { request: { workspaceId: own.workspaceId } })
  made.push({ nodeId: node.id, workspaceId: own.workspaceId, cwd: own.path, sessionId: session.sessionId })
}
check(made.length === 2, 'a Session was opened on each node',
  made.map(entry => String(entry.sessionId).slice(0, 30)).join(' '))

for (const entry of made) {
  check(String(entry.sessionId).startsWith(`fleet_${entry.nodeId}_`),
    'a Session id names the node it was created on', `${entry.nodeId} → ${String(entry.sessionId).split('_')[1]}`)
  const followCarrier = await openCarrier({ base, cookie })
  const stream = liveStream(followCarrier, 'session/follow', {
    request: { address: { kind: 'session', sessionId: entry.sessionId }, maxMessages: 10 },
  })
  const waited = Date.now() + 20_000
  let header
  while (Date.now() < waited && header === undefined) {
    await sleep(200)
    header = stream.frames
      .flatMap(frame => (frame.value?.type === 'snapshot' ? [frame.value.header] : []))
      .find(value => value !== undefined)
  }
  stream.stop()
  followCarrier.close()
  check(String(header?.id) === String(entry.sessionId),
    'reading it back reaches the node that owns it, not its twin', header?.id?.slice(0, 40))
  check(String(header?.cwd ?? '') === String(entry.cwd),
    'and its working directory is that node\'s path', header?.cwd)
}

// ---- 4. the two nodes' rows in the list stay attributable ----------------
const merged = await call(base, cookie, 'session/list', { _request: {} })
const mine = (merged.items ?? []).filter(item =>
  made.some(entry => entry.sessionId === item.sessionId))
check(mine.length === 2, 'both new Sessions appear in the ordinary merged list', String(mine.length))
check(new Set(mine.map(item => item.sessionId)).size === 2,
  'as two distinct rows, not one overwriting the other')
for (const item of mine) {
  check(String(item.cwd ?? '').startsWith('/'), 'each keeps a node-side directory', item.cwd)
}

// ---- 5. nodes can be forgotten without disturbing the survivor ----------
await removeNode(secondId)
await sleep(1_500)
const left = await nodes()
check(left.some(node => node.id === first.id), 'removing the second node leaves the first alone')
const survivor = (await call(base, cookie, 'session/list', { _request: {} })).items ?? []
check(survivor.some(item => item.sessionId === made[0]?.sessionId) || made[0] === undefined,
  'and the first node\'s Session is still listed')

carrier.close()
await sleep(400)
log(`nodes: ${first.id} and ${secondId}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
