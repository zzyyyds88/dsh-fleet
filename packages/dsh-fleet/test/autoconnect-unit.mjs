/**
 * `Fleet.autoConnect()` — the startup path that makes a node appear without a click.
 *
 * The bug this file exists for: `autoConnect` decided whether to connect from
 * `runtime.credentialsReady()`, but a runtime's secret is only adopted by `put()` and
 * `connect()`. On a Host that just started, every runtime therefore read "no credential"
 * and the loop skipped every node — measured after a restart: the settings page showed
 * every node 未连接 and no remote workspace appeared, which is indistinguishable from
 * "the plugin is broken". Clicking 连接 by hand worked, which is the manual step
 * autoConnect exists to remove.
 *
 * The fixture drives the real `Fleet` with an in-memory registry and an in-memory
 * credential store, and spies on `fleet.connect` so no SSH is dialled.
 */
import { Fleet } from '../src/host/fleet.js'
import { NodeRegistry } from '../src/core/registry.js'

let failed = 0
const checks = []
function ok(condition, message, detail) {
  checks.push({ condition, message })
  if (!condition) failed += 1
  console.log(`[autoconnect] ${condition ? 'ok  ' : 'FAIL'} ${message}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---- fixture ---------------------------------------------------------------
const NODE_ID = 'n00a5f7394401'
const nodes = [{
  id: NODE_ID, name: 'probe-93', transport: 'ssh', host: '10.0.0.1', port: 22,
  username: 'root', auth: { kind: 'password' }, remoteRoot: '~/.dsh-fleet', enabled: true,
  createdAt: 1, updatedAt: 1,
}]
const stored = new Map([[`dsh-fleet/${NODE_ID}`, {
  kind: 'grant',
  payload: { version: 1, kind: 'password', password: 'not-a-real-secret' },
}]])

const credentials = {
  async readRecord(key) { return stored.get(key) },
  async modifyRecord(key, mutate) { stored.set(key, await mutate(stored.get(key))) },
  async deleteRecord(key) { stored.delete(key) },
  async describeRecord(key) { return { present: stored.has(key) } },
}

// The registry reads a JSON file under `$DSH_HOME`; replace its two reads so this test
// touches no disk and cannot be affected by whatever nodes the machine really has.
const realList = NodeRegistry.prototype.list
const realGet = NodeRegistry.prototype.get
NodeRegistry.prototype.list = function list() { return nodes.map(node => ({ ...node, auth: { ...node.auth } })) }
NodeRegistry.prototype.get = function get(id) { return nodes.find(node => node.id === id) }

const newFleet = () => {
  const fleet = new Fleet({ credentials, version: '0.2.2-rc.3', log: () => {} })
  let attempts = 0
  fleet.connect = async runtime => { attempts += 1; return runtime.describe() }
  return { fleet, attempts: () => attempts }
}
const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- 1. a freshly built Fleet knows nothing about the stored secret ----------
{
  const { fleet } = newFleet()
  const described = fleet.list()[0].describe()
  ok(described.credentialsReady === false,
    'a runtime created at startup does not know the stored credential yet',
    `credentialsReady=${String(described.credentialsReady)}`)
}

// ---- 2. autoConnect adopts it and connects -------------------------------
{
  const { fleet, attempts } = newFleet()
  const timer = fleet.autoConnect(0)
  await settle(80)
  clearTimeout(timer)
  await settle(40)
  ok(attempts() === 1, 'autoConnect connects the node whose credential is stored', `attempts=${String(attempts())}`)
  ok(fleet.list()[0].describe().credentialsReady === true,
    'and the node now reports its credential as ready, so the settings page says so too')
}

// ---- 3. a node with no stored credential is still skipped ----------------
{
  stored.delete(`dsh-fleet/${NODE_ID}`)
  const { fleet, attempts } = newFleet()
  const timer = fleet.autoConnect(0)
  await settle(80)
  clearTimeout(timer)
  await settle(40)
  ok(attempts() === 0, 'a node with no stored credential is not dialled', `attempts=${String(attempts())}`)
  stored.set(`dsh-fleet/${NODE_ID}`, {
    kind: 'grant',
    payload: { version: 1, kind: 'password', password: 'not-a-real-secret' },
  })
}

// ---- 4. a disabled node is not dialled -----------------------------------
{
  nodes[0].enabled = false
  const { fleet, attempts } = newFleet()
  const timer = fleet.autoConnect(0)
  await settle(80)
  clearTimeout(timer)
  await settle(40)
  ok(attempts() === 0, 'a disabled node is not dialled even with a credential', `attempts=${String(attempts())}`)
  nodes[0].enabled = true
}

// ---- 5. a failing credential store must not take the loop down -----------
{
  const broken = new Fleet({
    credentials: {
      async readRecord() { throw new Error('credential store is unavailable') },
      async modifyRecord() { throw new Error('credential store is unavailable') },
      async deleteRecord() { throw new Error('credential store is unavailable') },
      async describeRecord() { return { present: false } },
    },
    version: '0.2.2-rc.3',
    log: () => {},
  })
  let attempts = 0
  broken.connect = async () => { attempts += 1 }
  const timer = broken.autoConnect(0)
  await settle(80)
  clearTimeout(timer)
  ok(attempts === 0, 'an unreadable credential store is logged, not thrown out of the timer')
}

NodeRegistry.prototype.list = realList
NodeRegistry.prototype.get = realGet

console.log('')
if (failed > 0) {
  console.error(`[autoconnect] ${failed} of ${checks.length} checks failed`)
  process.exitCode = 1
} else {
  console.log(`[autoconnect] all ${checks.length} checks passed`)
}
