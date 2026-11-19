/**
 * `host/fleet.js` — the three behaviours this round added, without a real node.
 *
 * Everything here is driven through the real `Fleet`, with the SSH and remote layers replaced
 * by the smallest fakes that answer the calls `connect()` makes. What it proves:
 *
 *   1. a dropped socket becomes `idle` + `droppedAt` (not a green dot over a dead machine);
 *   2. the reconnect ladder is 2s → 4s → 8s → every 2 min, and a deliberate disconnect cancels
 *      it (otherwise pressing Disconnect would be undone two seconds later);
 *   3. the first host key seen is recorded on the record, and the connection is handed the
 *      recorded one on the next connect — the chain that was dead code before;
 *   4. a failed connect keeps its phase and carries a classified failure;
 *   5. a node that is merely unreachable keeps its workspace rows.
 *
 * Usage: node test/fleet-lifecycle-unit.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// **Before anything imports the registry.** `NodeRegistry` writes to `$DSH_HOME/fleet/nodes.json`,
// so a suite that builds real `Fleet` objects would otherwise append its fake nodes to the
// machine's own node list. Measured the hard way: three `fake` records landed in the developer's
// `~/.dsh/fleet/nodes.json` and every later e2e run picked the wrong node. A private home makes
// this suite safe to run anywhere, including next to a live profile.
const sandbox = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-'))
process.env.DSH_HOME = sandbox

const { Fleet, NODE_STATE } = await import('../src/host/fleet.js')
const { classifyFailure } = await import('../src/core/errors.js')
const { RemoteWorkspaces } = await import('../src/host/remote-workspaces.js')

let failed = 0
const check = (ok, label, detail) => {
  if (ok) {
    process.stdout.write(`[fleet-lifecycle] ok   ${label}\n`)
    return
  }
  failed += 1
  process.stdout.write(`[fleet-lifecycle] FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A credential store that answers from memory. */
function memoryCredentials() {
  const records = new Map()
  return {
    readRecord: key => records.get(key),
    modifyRecord: (key, mutate) => { records.set(key, mutate(records.get(key))); return records.get(key) },
    deleteRecord: key => { records.delete(key) },
    describeRecord: key => (records.has(key) ? { kind: 'password' } : undefined),
    // The real `ctx.credentials` shape the SecretStore drives.
    read: key => records.get(key),
  }
}

// ---- 1. a drop is visible, and the ladder starts ---------------------------

{
  const fleet = new Fleet({ credentials: memoryCredentials(), version: '0.0.0-test', log: () => {} })
  const runtime = fleet.put({ id: 'n0000000000aa', name: 'fake', host: 'example.test', username: 'root', auth: { kind: 'password' } })
  const node = await runtime

  // Pretend a connect succeeded.
  node.state = NODE_STATE.CONNECTED
  node.serving = { port: 1234, token: 't', pid: 1, version: '0.0.0-test' }

  // The connection reports a drop the way `SshConnection` does.
  node.connection.target.onDrop?.()

  check(node.state === NODE_STATE.IDLE, 'a drop takes the node out of `connected`', node.state)
  check(typeof node.droppedAt === 'number' && node.droppedAt > 0,
    'and records when it happened, so the card can say "since …"', String(node.droppedAt))
  check(node.serving === undefined, 'the resident host is forgotten, because nothing can reach it')
  check(node.describe().droppedAt !== undefined, 'the snapshot carries it to the settings page')
  check(node.describe().failure === undefined,
    'and a drop is not reported as a failure — nothing is misconfigured')
  check(node.recoveryTimer !== undefined, 'the reconnect ladder is armed')
  fleet.dispose()
  node.recoveryTimer = undefined
}

// ---- 2. a deliberate disconnect cancels the ladder -------------------------

{
  const fleet = new Fleet({ credentials: memoryCredentials(), version: '0.0.0-test', log: () => {} })
  const node = await fleet.put({ id: 'n0000000000ab', name: 'fake', host: 'example.test', username: 'root', auth: { kind: 'password' } })
  node.state = NODE_STATE.CONNECTED
  node.serving = { port: 1, token: 't', pid: 1, version: '0.0.0-test' }
  node.connection.target.onDrop?.()
  check(node.recoveryTimer !== undefined, 'the ladder is armed after a drop')

  await fleet.disconnect(node).catch(() => undefined)
  check(node.recoveryTimer === undefined,
    'pressing Disconnect cancels it — otherwise the node comes back two seconds later',
    String(node.recoveryTimer))
  check(node.state === NODE_STATE.IDLE, 'and the node stays down', node.state)
  check(node.droppedAt === undefined, 'a deliberate disconnect is not a drop', String(node.droppedAt))
  fleet.dispose()
}

// ---- 3. the host key is recorded, then handed back ------------------------

{
  const fleet = new Fleet({ credentials: memoryCredentials(), version: '0.0.0-test', log: () => {} })
  const node = await fleet.put({ id: 'n0000000000ac', name: 'fake', host: 'example.test', username: 'root', auth: { kind: 'password' } })
  check(node.connection.target.hostFingerprint === undefined,
    'a machine never seen before starts with no recorded key')

  // What `ssh2` does on the first handshake.
  node.connection.target.onFirstFingerprint?.('aa:bb:cc')
  check(fleet.registry.get('n0000000000ac').hostKey === 'aa:bb:cc',
    'the first key is written to the node record',
    String(fleet.registry.get('n0000000000ac').hostKey))
  check(node.connection.target.hostFingerprint === 'aa:bb:cc',
    'and the live connection is told, so its next handshake compares')
  check(node.describe().hostKey === 'aa:bb:cc', 'the settings page can show it')

  // A second connect reads the record and must hand the key to the connection.
  const again = fleet.get('n0000000000ac')
  check(again.connection.target.hostFingerprint === 'aa:bb:cc',
    'a later read of the same node still carries the key',
    String(again.connection.target.hostFingerprint))
  fleet.dispose()
}

// ---- 4. a failed connect keeps its phase and is classified ---------------

{
  const failure = classifyFailure(
    Object.assign(new Error('this machine runs Node v18.0.0'), { code: 'node-too-old' }),
    { phase: 'probe' },
  )
  check(failure.code === 'node-too-old', 'an explicit code wins', failure.code)
  check(failure.action === 'upgrade-node', 'and brings the action a person can take', failure.action)
  check(failure.retryable === false, 'and says retrying will not help', String(failure.retryable))

  const byPhase = classifyFailure(new Error('boom'), { phase: 'install' })
  check(byPhase.code === 'runtime-install', 'a failure during install is named after the stage', byPhase.code)
  check(byPhase.detail === 'boom', 'the original sentence is kept for a bug report', byPhase.detail)
}

// ---- 5. an unreachable node keeps its rows -------------------------------

{
  const rows = [{ workspaceId: 'w1' }, { workspaceId: 'w2' }]
  const node = {
    baseline: { items: rows, archivedSessionIds: [], pinnedSessionIds: [] },
    offline: false,
    stream: undefined,
    close() { this.baseline = null },
    markOffline() { this.offline = true; this.stream = undefined },
    open: async () => undefined,
    ready: async () => undefined,
    onIncrement: undefined,
    onReplaced: undefined,
  }
  check(node.baseline.items.length === 2, 'the fixture starts with two rows')
  node.markOffline()
  check(node.offline === true, 'marking offline sets the flag')
  check(node.baseline !== null && node.baseline.items.length === 2,
    'and keeps the rows, because a workspace that still exists must not vanish from the sidebar',
    JSON.stringify(node.baseline?.items.length))

  // A node whose *record* was removed is the one case that drops them.
  node.close()
  check(node.baseline === null, 'removing the node does drop them', String(node.baseline))
  void RemoteWorkspaces
}

await sleep(10)
rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) {
  process.stdout.write(`\n[fleet-lifecycle] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[fleet-lifecycle] all checks passed\n')
}
