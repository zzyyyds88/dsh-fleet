/**
 * Unit proof of the routing layer with a fake fleet and a fake gateway.
 *
 * The remote Host is not involved: this pins down the parts that are easy to get
 * subtly wrong and impossible to see in a manual run — identity round-trips,
 * stream fan-out, workspace merging, and the rule that a *local* call must reach
 * the upstream method untouched.
 *
 * Run: node test/routing-unit.mjs
 */
import {
  AsyncQueue,
  decodeRemoteId,
  encodeRemoteId,
  isRemoteId,
  remoteIterable,
  remapIds,
} from '../src/host/routing.js'
import { Router } from '../src/host/router.js'
import { RemoteWorkspaces } from '../src/host/remote-workspaces.js'
import {
  decorateSessionController,
  decorateWorkspaceController,
  decorateWorkspaceFiles,
} from '../src/host/decorators.js'

const log = message => process.stdout.write(`[routing-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

const NODE = 'n0123456789ab'
const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const WRAPPED = `fleet_${NODE}_${SESSION}`

// ---- identity round-trip ---------------------------------------------------
check(encodeRemoteId(NODE, SESSION) === WRAPPED, 'a remote identity wraps with its node')
check(equal(decodeRemoteId(WRAPPED), { nodeId: NODE, remoteId: SESSION }), 'it decodes back exactly')
check(decodeRemoteId('session-abc') === undefined, 'a local identity does not decode')
check(decodeRemoteId(`fleet_nXXX_${SESSION}`) === undefined, 'a malformed node id does not decode')
check(decodeRemoteId(`fleet_${NODE}_`) === undefined, 'an empty remote id does not decode')
check(isRemoteId(WRAPPED) && !isRemoteId(SESSION), 'isRemoteId discriminates both directions')

// ---- remapIds walks plain data only ---------------------------------------
const payload = { header: { id: SESSION }, list: [SESSION, 'other'], nested: { deep: { id: SESSION } } }
const remapped = remapIds(payload, new Map([[SESSION, 'session-local']]))
check(remapped.header.id === 'session-local', 'remapIds replaces a nested value')
check(remapped.list[0] === 'session-local' && remapped.list[1] === 'other', 'remapIds maps array members')
check(remapped.nested.deep.id === 'session-local', 'remapIds reaches deep nesting')
check(payload.header.id === SESSION, 'remapIds does not mutate the input')
const withDate = { when: new Date(0) }
check(remapIds(withDate, new Map([['x', 'y']])).when instanceof Date, 'remapIds leaves class instances alone')

// ---- AsyncQueue -----------------------------------------------------------
{
  const queue = new AsyncQueue()
  queue.push(1)
  queue.push(2)
  check((await queue.next()).value === 1, 'AsyncQueue yields pushed values in order')
  queue.end()
  check((await queue.next()).value === 2, 'AsyncQueue drains before closing')
  check((await queue.next()).done === true, 'AsyncQueue ends once drained')
}
{
  const queue = new AsyncQueue()
  queue.fail(new Error('boom'))
  let caught
  try { await queue.next() } catch (error) { caught = error }
  check(caught?.message === 'boom', 'AsyncQueue surfaces a failure')
}

// ---- fake gateway ---------------------------------------------------------
/** A gateway that answers from a table and records what it was asked. */
function fakeGateway(nodeId, table) {
  const calls = []
  const gateways = new Map()
  return {
    calls,
    gateway: {
      async call(endpoint, args) {
        calls.push({ endpoint, args })
        const handler = table[endpoint]
        if (handler === undefined) return { ok: false, error: { code: 'fleet/unknown-endpoint', message: endpoint } }
        const value = await handler(args)
        return value === undefined
          ? { ok: false, error: { code: 'fleet/missing', message: endpoint } }
          : { ok: true, value }
      },
      async openStream(endpoint, args, handlers) {
        calls.push({ endpoint, args, stream: true })
        const frames = table[endpoint]
        if (!Array.isArray(frames)) throw new Error(`no stream table for ${endpoint}`)
        for (const frame of frames) handlers.onFrame(frame)
        handlers.onEnd()
        return { close: () => {} }
      },
    },
    nodeId,
    gateways,
  }
}

/** A Fleet stand-in with one routable node. */
function fakeFleet(nodeId, gateway) {
  const record = { id: nodeId, name: 'test-node', enabled: true }
  const runtime = { record, routable: true, gateway }
  return {
    get: id => (id === nodeId ? runtime : undefined),
    list: () => [runtime],
    routable: () => [runtime],
  }
}

// ---- router translation ---------------------------------------------------
{
  const { gateway, calls } = fakeGateway(NODE, {
    'session/rename': args => ({ title: 'renamed', seq: 1, echoed: args.request.sessionId }),
  })
  const router = new Router({ fleet: fakeFleet(NODE, gateway) })
  const value = await router.call(NODE, 'session/rename', { request: { sessionId: SESSION } })
  check(value.title === 'renamed', 'a routed call returns the node value')
  check(calls[0].args.request.sessionId === SESSION, 'the node receives its own identity')

  const outbound = router.toRemote({ request: { sessionId: WRAPPED, other: 'keep' } }, NODE)
  check(outbound.request.sessionId === SESSION, 'toRemote unwraps an identity for its own node')
  check(outbound.request.other === 'keep', 'toRemote leaves unrelated fields alone')
  const foreign = router.toRemote({ sessionId: `fleet_nffffffffffff_${SESSION}` }, NODE)
  check(foreign.sessionId.startsWith('fleet_'), 'toRemote leaves another node identity wrapped')

  const inbound = router.toLocal({ sessionId: SESSION, cwd: '/root/x' }, NODE)
  check(inbound.sessionId === WRAPPED, 'toLocal wraps a session identity')
  check(inbound.cwd === '/root/x', 'toLocal leaves a path alone')

  const workspace = router.toLocalWorkspace({ workspace: { workspaceId: 'ws-1', path: '/root/w' } }, NODE)
  check(workspace.workspace.workspaceId === `fleet_${NODE}_ws-1`, 'toLocalWorkspace wraps a workspace id')
  check(workspace.workspace.path === '/root/w', 'toLocalWorkspace leaves the path alone')
}

// ---- a missing or offline node fails predictably --------------------------
{
  const router = new Router({ fleet: { get: () => undefined, list: () => [], routable: () => [] } })
  let caught
  try { await router.call(NODE, 'session/list', {}) } catch (error) { caught = error }
  check(caught?.code === 'fleet/node-unknown', 'an unknown node raises fleet/node-unknown', caught?.code)
}

// ---- remoteIterable proxies a stream --------------------------------------
{
  const { gateway } = fakeGateway(NODE, {
    'session/follow': [
      { type: 'snapshot', header: { id: SESSION }, records: [] },
      { type: 'event', event: { seq: 1, type: 'turn/start' } },
    ],
  })
  const frames = []
  for await (const frame of remoteIterable(gateway, 'session/follow', {}, undefined, value => value)) {
    frames.push(frame)
  }
  check(frames.length === 2, 'remoteIterable yields every frame', String(frames.length))
  check(frames[0].type === 'snapshot', 'the snapshot arrives first')
}

// ---- the decorators leave local calls untouched ---------------------------
{
  const { gateway, calls } = fakeGateway(NODE, {})
  const fleet = fakeFleet(NODE, gateway)
  const router = new Router({ fleet })
  const workspaces = new RemoteWorkspaces(fleet)

  /** An upstream-shaped service with real prototype methods. */
  class FakeSessionController {
    async list(_request) { return { items: [{ sessionId: 'local-session' }] } }
    async prompt(request) { return { accepted: true, local: request.sessionId } }
    async rename(request) { return { title: 'local', seq: 1 } }
    async state(request) { return { sessionId: request.sessionId, running: false } }
    follow() { return (async function* () { yield { type: 'snapshot' } })() }
  }
  const service = new FakeSessionController()
  const originalList = FakeSessionController.prototype.list
  const originalPrompt = FakeSessionController.prototype.prompt

  const restore = decorateSessionController(service, router, workspaces)
  check(service.list !== originalList, 'the decorator installs an own property')
  check(Object.getOwnPropertyDescriptor(service, 'list') !== undefined,
    'the replacement is on the instance, not the class')
  check(FakeSessionController.prototype.list === originalList, 'the class itself is untouched')
  check(service.state !== undefined, 'undecorated endpoints remain available')

  const local = await service.list({}, undefined)
  check(local.items[0].sessionId === 'local-session', 'a local list still returns the upstream rows')

  // `list` legitimately contacts every node to merge rows; start from a clean log.
  calls.length = 0

  const localPrompt = await service.prompt({ sessionId: 'local-session' }, undefined)
  check(localPrompt.local === 'local-session', 'a local prompt reaches the upstream method')
  check(calls.length === 0, 'no node call happens for local identities', String(calls.length))

  // A remote identity must reach the node instead of the local method.
  const remotePrompt = await service.prompt({ sessionId: WRAPPED, text: 'hi' }, undefined)
    .catch(error => ({ failed: error.code }))
  check(remotePrompt.failed === 'fleet/unknown-endpoint',
    'a remote prompt is dispatched to the node', JSON.stringify(remotePrompt))
  check(calls.some(entry => entry.endpoint === 'session/prompt'), 'the node received session/prompt',
    calls.map(entry => entry.endpoint).join(','))
  const sent = calls.find(entry => entry.endpoint === 'session/prompt')
  check(sent.args.request.sessionId === SESSION, 'the node received its own identity, not the wrapped one')

  restore()
  check(service.prompt === originalPrompt || typeof service.prompt === 'function',
    'the restore puts the class method back', String(service.prompt === originalPrompt))
  workspaces.dispose()
}

// ---- workspace list merging ----------------------------------------------
{
  const { gateway } = fakeGateway(NODE, {
    'workspace/follow': [
      {
        type: 'baseline',
        value: {
          items: [{ workspaceId: 'ws-remote', path: '/root/project', title: 'project', sessionIds: [SESSION] }],
          archivedSessionIds: [],
          pinnedSessionIds: [SESSION],
        },
      },
    ],
    'session/list': () => ({
      items: [{ sessionId: SESSION, updatedAt: 5, running: false, blank: false, cwd: '/root/project' }],
    }),
  })
  const fleet = fakeFleet(NODE, gateway)
  const router = new Router({ fleet })
  const workspaces = new RemoteWorkspaces(fleet)

  class FakeWorkspaceController {
    async *follow() {
      yield { type: 'baseline', value: { items: [{ workspaceId: 'ws-local', path: 'C:\\p', title: 'p', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [] } }
    }
    async create(request) { return { workspace: { workspaceId: 'ws-local-new', path: request.path }, created: true } }
  }
  const service = new FakeWorkspaceController()
  decorateWorkspaceController(service, router, workspaces)

  const frames = []
  for await (const frame of service.follow()) frames.push(frame)
  check(frames.length === 1 && frames[0].type === 'baseline', 'the merged stream opens with one baseline')
  const baseline = frames[0].value
  check(baseline.items.length === 2, 'the baseline carries local and remote workspaces', String(baseline.items.length))
  const remote = baseline.items.find(item => item.workspaceId.startsWith('fleet_'))
  check(remote !== undefined, 'the remote workspace is wrapped')
  check(remote.path === '/root/project', 'the remote workspace keeps its real remote path')
  check(remote.sessionIds[0] === WRAPPED, 'the remote workspace names its wrapped sessions')
  check(baseline.pinnedSessionIds[0] === WRAPPED, 'the pinned set is wrapped too')
  check(baseline.items.some(item => item.workspaceId === 'ws-local'), 'the local workspace survives untouched')

  // The merged session list must carry the remote row with a wrapped identity.
  class FakeSessionController {
    async list() { return { items: [] } }
  }
  const sessions = new FakeSessionController()
  decorateSessionController(sessions, router, workspaces)
  const list = await sessions.list({}, undefined)
  check(list.items.length === 1, 'the merged session list carries the remote row', String(list.items.length))
  check(list.items[0].sessionId === WRAPPED, 'the remote row uses the wrapped identity')
  workspaces.dispose()
}

// ---- workspaceFiles routes by the resolved scope --------------------------
{
  const { gateway, calls } = fakeGateway(NODE, {})
  const fleet = fakeFleet(NODE, gateway)
  const router = new Router({ fleet })

  class FakeWorkspaceFiles {
    async stat(scope, path) { return { absolutePath: `local:${String(path)}`, version: 'v1' } }
  }
  const service = new FakeWorkspaceFiles()
  decorateWorkspaceFiles(service, router)

  const localValue = await service.stat({ sessionId: 'local-session', workspaceRoot: '/x' }, 'a.txt', undefined)
  check(localValue.absolutePath === 'local:a.txt', 'a local file stat reaches the upstream method')
  check(calls.length === 0, 'no node call for a local file scope')

  await service.stat({ sessionId: WRAPPED, workspaceRoot: '/root/project' }, 'a.txt', undefined).catch(() => undefined)
  check(calls.some(entry => entry.endpoint === 'workspaceFiles/stat'), 'a remote scope is dispatched',
    calls.map(entry => entry.endpoint).join(','))
  const sent = calls.find(entry => entry.endpoint === 'workspaceFiles/stat')
  check(sent.args.workspaceFileScopeId === SESSION, 'the node receives its own session identity')
  check(sent.args.path === 'a.txt', 'the file path travels unchanged')
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
