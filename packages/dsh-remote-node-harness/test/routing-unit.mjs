/**
 * Unit proof of the routing layer with a fake rnh and a fake gateway.
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
import { mergeControlStream } from '../src/host/remote-control.js'
import { RemoteWorkspaces } from '../src/host/remote-workspaces.js'
import {
  decorateJobController,
  decorateSessionController,
  decorateSessionQuery,
  decorateTeamService,
  decorateTerminalController,
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
const WRAPPED = `rnh_${NODE}_${SESSION}`

// ---- identity round-trip ---------------------------------------------------
check(encodeRemoteId(NODE, SESSION) === WRAPPED, 'a remote identity wraps with its node')
check(equal(decodeRemoteId(WRAPPED), { nodeId: NODE, remoteId: SESSION }), 'it decodes back exactly')
check(decodeRemoteId('session-abc') === undefined, 'a local identity does not decode')
check(decodeRemoteId(`rnh_nXXX_${SESSION}`) === undefined, 'a malformed node id does not decode')
check(decodeRemoteId(`rnh_${NODE}_`) === undefined, 'an empty remote id does not decode')
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
        if (handler === undefined) return { ok: false, error: { code: 'rnh/unknown-endpoint', message: endpoint } }
        const value = await handler(args)
        return value === undefined
          ? { ok: false, error: { code: 'rnh/missing', message: endpoint } }
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

/** A Rnh stand-in with one routable node. */
function fakeRnh(nodeId, gateway) {
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
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })
  const value = await router.call(NODE, 'session/rename', { request: { sessionId: SESSION } })
  check(value.title === 'renamed', 'a routed call returns the node value')
  check(calls[0].args.request.sessionId === SESSION, 'the node receives its own identity')

  const outbound = router.toRemote({ request: { sessionId: WRAPPED, other: 'keep' } }, NODE)
  check(outbound.request.sessionId === SESSION, 'toRemote unwraps an identity for its own node')
  check(outbound.request.other === 'keep', 'toRemote leaves unrelated fields alone')
  const foreign = router.toRemote({ sessionId: `rnh_nffffffffffff_${SESSION}` }, NODE)
  check(foreign.sessionId.startsWith('rnh_'), 'toRemote leaves another node identity wrapped')

  const inbound = router.toLocal({ sessionId: SESSION, cwd: '/root/x' }, NODE)
  check(inbound.sessionId === WRAPPED, 'toLocal wraps a session identity')
  check(inbound.cwd === '/root/x', 'toLocal leaves a path alone')

  // A subagent's own Session has no `session-` marker: the node lists it as a bare
  // uuid. Only the field name says it is an identity, and a listed child row that
  // stayed a bare uuid made the client address a Session nothing on this Host knew.
  const BARE = '93f9bbcf-bba5-4284-a0ed-9b5ee3803d8e'
  const child = router.toLocal({ sessionId: BARE, parentSessionId: SESSION, cwd: '/root/y' }, NODE)
  check(child.sessionId === `rnh_${NODE}_${BARE}`, 'toLocal wraps a bare subagent Session id', child.sessionId)
  check(child.parentSessionId === WRAPPED, 'toLocal wraps the parent id on the same row')
  check(child.cwd === '/root/y', 'toLocal leaves the path alone on a child row')
  const address = router.toLocal({
    address: { kind: 'subagent', parentSessionId: SESSION, childSessionId: BARE, mode: 'unknown' },
  }, NODE)
  check(address.address.childSessionId === `rnh_${NODE}_${BARE}`, 'toLocal wraps an address child id')
  check(address.address.parentSessionId === WRAPPED, 'toLocal wraps an address parent id')
  const unrelated = router.toLocal({ id: BARE, label: 'not an identity field' }, NODE)
  check(unrelated.id === BARE, 'a bare uuid outside a Session field is left alone')

  // A relayed Host event names its Session **by position**, so there is no field
  // name for `toLocal` to read. Measured: a subagent's `api-session/status` arrived
  // here as `[bareUuid, true]`, was passed through unwrapped, and the sidebar looked
  // the child up by its wrapped id — a parent row showed "0 subagents running" for a
  // whole remote turn.
  const status = router.toLocalEventArgs('api-session/status', [BARE, true], NODE)
  check(status[0] === `rnh_${NODE}_${BARE}`, 'a status event wraps a bare subagent id in first position', status[0])
  check(status[1] === true, 'a status event keeps its running flag')
  const activity = router.toLocalEventArgs('api-session/activity', [SESSION, 12], NODE)
  check(activity[0] === WRAPPED, 'an activity event wraps a marked session id', activity[0])
  check(activity[1] === 12, 'an activity event keeps its sequence number')
  const added = router.toLocalEventArgs('api-session/added', [{ sessionId: BARE, cwd: '/root/z' }], NODE)
  check(added[0].sessionId === `rnh_${NODE}_${BARE}`, 'an added event still wraps by field name')
  const again = router.toLocalEventArgs('api-session/status', [`rnh_${NODE}_${BARE}`, false], NODE)
  check(again[0] === `rnh_${NODE}_${BARE}`, 'an already-wrapped event id is not wrapped twice', again[0])

  const workspace = router.toLocalWorkspace({ workspace: { workspaceId: 'ws-1', path: '/root/w' } }, NODE)
  check(workspace.workspace.workspaceId === `rnh_${NODE}_ws-1`, 'toLocalWorkspace wraps a workspace id')
  check(workspace.workspace.path === '/root/w', 'toLocalWorkspace leaves the path alone')
}

// ---- a missing or offline node fails predictably --------------------------
{
  const router = new Router({ rnh: { get: () => undefined, list: () => [], routable: () => [] } })
  let caught
  try { await router.call(NODE, 'session/list', {}) } catch (error) { caught = error }
  check(caught?.code === 'rnh/node-unknown', 'an unknown node raises rnh/node-unknown', caught?.code)
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
  const rnh = fakeRnh(NODE, gateway)
  const router = new Router({ rnh })
  const workspaces = new RemoteWorkspaces(rnh)

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
  check(remotePrompt.failed === 'rnh/unknown-endpoint',
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
  const rnh = fakeRnh(NODE, gateway)
  const router = new Router({ rnh })
  const workspaces = new RemoteWorkspaces(rnh)

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
  const remote = baseline.items.find(item => item.workspaceId.startsWith('rnh_'))
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
  const rnh = fakeRnh(NODE, gateway)
  const router = new Router({ rnh })

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

// ---- the job roster routes by Session, and only by Session ---------------
{
  const { gateway, calls } = fakeGateway(NODE, {
    'job/list': [ { type: 'rows', jobs: [{ id: `bash-${NODE}`, status: 'running', label: 'node job' }] } ],
    'job/follow': [ { type: 'opened', job: { id: 'bash-x' }, from: 0 } ],
    'job/kill': args => ({ outcome: 'requested', echoed: args.request.sessionId }),
  })
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })

  class FakeJobController {
    async kill(request) { return { outcome: 'requested', local: request.sessionId } }
    list() { return (async function* () { yield { type: 'rows', jobs: [{ id: 'local-job' }] } })() }
    follow() { return (async function* () { yield { type: 'opened', job: { id: 'local-job' }, from: 0 } })() }
  }
  const service = new FakeJobController()
  decorateJobController(service, router)

  // A local Session still reaches the upstream method, untouched.
  const localKill = await service.kill({ sessionId: 'local-session', jobId: 'bash-1' }, undefined)
  check(localKill.local === 'local-session', 'a local job kill reaches the upstream method')
  check(calls.length === 0, 'no node call for a local job', String(calls.length))

  // A remote Session reaches the node, and the node sees its own identity.
  const remoteKill = await service.kill({ sessionId: WRAPPED, jobId: 'bash-1' }, undefined)
  check(remoteKill.outcome === 'requested', 'a remote job kill is dispatched')
  const killed = calls.find(entry => entry.endpoint === 'job/kill')
  check(killed?.args.request.sessionId === SESSION, 'the node receives its own session identity')
  check(killed?.args.request.jobId === 'bash-1', 'the job id travels unchanged')

  // The roster stream carries the node's rows, with its `owner` wrapped.
  const rows = []
  for await (const frame of service.list({ sessionId: WRAPPED }, undefined)) rows.push(frame)
  check(rows.length === 1 && rows[0].jobs[0].id === `bash-${NODE}`,
    'a remote job roster is proxied frame by frame', JSON.stringify(rows).slice(0, 80))
  const listed = calls.find(entry => entry.endpoint === 'job/list')
  check(listed?.args.request.sessionId === SESSION, 'the roster stream names the node identity')

  // `job/follow` has an OPTIONAL sessionId (an unowned job is visible to every
  // caller). With no Session there is no node to pick, so it must stay local
  // rather than guess.
  calls.length = 0
  const orphaned = []
  for await (const frame of service.follow({ jobId: 'bash-1' }, undefined)) orphaned.push(frame)
  check(orphaned[0]?.job?.id === 'local-job', 'a job follow with no Session stays local')
  check(calls.length === 0, 'and asks no node', String(calls.length))
}

// ---- the terminal namespace routes both key shapes ------------------------
// `terminal` has two families: three endpoints take a Session id, six take an
// `Agent` object. The decorator keys off `agent.id`, so the test drives both and
// proves a local call still reaches the upstream body untouched.
{
  const { gateway, calls } = fakeGateway(NODE, {
    'terminal/list': () => [{ id: 't-node', title: 'node shell', state: 'running' }],
    'terminal/environment': () => ({ cwd: '/root/x', maxInputBytes: 1024 }),
    'terminal/shells': () => [{ path: '/bin/bash', args: [], name: 'bash' }],
    'terminal/create': args => ({ id: args.request.id, title: 'created', cwd: '/root/x' }),
    'terminal/rename': () => null,
    'terminal/close': () => null,
  })
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })

  class FakeTerminalController {
    list(sessionId) { return [{ id: 't-local', title: 'local', sessionId }] }
    environment(agent) { return { cwd: '/local', agentId: agent?.id } }
    shells(agent) { return [{ path: 'pwsh', args: [], name: 'pwsh', forAgent: agent?.id }] }
    async create(agent, request) { return { id: request.id, local: agent?.id } }
    async rename(agent, id, title) { return { local: [agent?.id, id, title] } }
    async close(agent, id) { return { local: [agent?.id, id] } }
  }
  const service = new FakeTerminalController()
  decorateTerminalController(service, router)

  // A local Session still reaches the upstream body.
  check((await service.list('session-local'))[0].id === 't-local', 'a local terminal list stays local')
  check(calls.length === 0, 'and asks no node', String(calls.length))

  // `list` routes by Session id.
  const rows = await service.list(WRAPPED)
  check(rows[0]?.id === 't-node', 'a remote terminal list is proxied', JSON.stringify(rows))
  check(calls.at(-1)?.args.sessionId === SESSION, 'the node receives its own Session id')

  // The six `Agent`-shaped endpoints route by `agent.id`. A remote call arrives
  // with the placeholder `{ id: <wrapped> }` that `overrideAgentLookup` synthesized.
  const placeholder = { id: WRAPPED }
  const env = await service.environment(placeholder)
  check(env.cwd === '/root/x', 'a remote terminal environment is proxied', JSON.stringify(env))
  check(calls.at(-1)?.args.agentId === SESSION, 'the node receives a bare agentId, not an rnh_ one')

  const shells = await service.shells(placeholder)
  check(shells[0]?.name === 'bash', 'shell discovery is proxied')

  const created = await service.create(placeholder, { id: 't-new', cols: 80, rows: 24 })
  check(created.id === 't-new', 'a remote terminal create returns the node info')
  check(calls.at(-1)?.args.request.id === 't-new', 'and its request travels intact')

  await service.rename(placeholder, 't-new', 'renamed')
  check(calls.at(-1)?.endpoint === 'terminal/rename', 'rename is routed')
  check(calls.at(-1)?.args.title === 'renamed', 'with the new title')

  await service.close(placeholder, 't-new')
  check(calls.at(-1)?.endpoint === 'terminal/close', 'close is routed')

  // A local Agent must never be sent to a node.
  calls.length = 0
  const localEnv = await service.environment({ id: 'session-local' })
  check(localEnv.agentId === 'session-local', 'a local agent still reaches the upstream method')
  check(calls.length === 0, 'and no node is contacted', String(calls.length))
}

// ---- the composer's 智能体协作 switch reaches the node ----------------------
// Upstream resolves the `Agent` parameter before the body runs, so a wrapped id
// reaches this decorator as the placeholder `{ id: <rnh_…> }`. Handing that to
// upstream asks `subagents.rootOf()` for a live caller no placeholder can be, which
// answered `subagent tree access requires the exact live caller` and lost the switch.
{
  // Upstream `setEnabled` returns void; the fake gateway treats `undefined` as a
  // missing answer, so the handler reports its own acknowledgement instead.
  const { gateway, calls } = fakeGateway(NODE, { 'agentTeams/setEnabled': () => ({ applied: true }) })
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })
  class FakeTeamService {
    async setEnabled(agent, enabled) { throw new Error(`upstream must not run for a remote Agent (${agent?.id})`) }
  }
  const service = new FakeTeamService()
  decorateTeamService(service, router)

  await service.setEnabled({ id: WRAPPED, ctx: {} }, true, undefined)
  check(calls.at(-1)?.endpoint === 'agentTeams/setEnabled', 'the team switch is dispatched to the node')
  check(calls.at(-1)?.args.agentId === SESSION, 'the node receives its own Session id as agentId')
  check(calls.at(-1)?.args.enabled === true, 'and the requested mode')

  // A local Agent still reaches the upstream body.
  calls.length = 0
  let upstreamRan = false
  service.setEnabled = async (agent, enabled) => { upstreamRan = agent?.id === 'session-local' && enabled === false }
  decorateTeamService(service, router)
  await service.setEnabled({ id: 'session-local' }, false, undefined)
  check(upstreamRan, 'a local Agent still reaches the upstream method')
  check(calls.length === 0, 'and asks no node', String(calls.length))
}

// ---- the deliverables route reads a remote Session's event ------------------
// `sessionQuery.readEvent` is Host-internal, so a remote Session's event is not in
// this Host's query engine: the route that backs "show in file manager" answered 404
// for every remote file. Emulating the read turns that into the honest refusal (a file
// on a node has no local file manager), which the card already has copy for.
{
  const { gateway, calls } = fakeGateway(NODE, {
    'session/page': args => ({
      cursor: args.request.throughSeq,
      records: [
        { type: 'event', event: { type: 'deliverables/presented', seq: 4, data: { files: [] } } },
        { type: 'event', event: { type: 'deliverables/presented', seq: 5, data: { files: [{ path: 'a.xlsx' }] } } },
      ],
    }),
    'session/list': () => ({ items: [{ sessionId: SESSION, cwd: '/root/project', createdAt: 7 }] }),
  })
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })
  class FakeSessionQuery {
    async readEvent() { throw new Error('the upstream read must not run for a remote Session') }
  }
  const service = new FakeSessionQuery()
  decorateSessionQuery(service, router)

  const window = await service.readEvent({ sessionId: WRAPPED, seq: 5, before: 0, after: 0 })
  check(window.target?.seq === 5, 'a remote event is read from the node', String(window.target?.seq))
  check(window.session?.cwd === '/root/project', 'the node Session header supplies the workspace root', String(window.session?.cwd))
  // The route resolves the declared file against that root; the id it hands back has to be
  // the local (wrapped) identity, or its own follow-up call routes nowhere.
  check(window.session?.id === WRAPPED, 'the header names the Session in local form', String(window.session?.id))
  check(calls[0]?.endpoint === 'session/page' && calls[0]?.args.request.throughSeq === 5,
    'the read is pinned at the event seq')
  check(calls[0]?.args.request.address.sessionId === SESSION, 'the node is asked for its own Session')

  // An event the node does not have is the node's own answer, not a silent empty window.
  let missing
  try { await service.readEvent({ sessionId: WRAPPED, seq: 99, before: 0, after: 0 }) } catch (error) { missing = error }
  check(missing?.code === 'SESSION_QUERY_EVENT_NOT_FOUND', 'an absent event reports the query code', String(missing?.code))

  // A local Session still reaches the upstream method.
  calls.length = 0
  let upstreamRan = false
  service.readEvent = async request => { upstreamRan = request.sessionId === 'session-local' }
  decorateSessionQuery(service, router)
  await service.readEvent({ sessionId: 'session-local', seq: 1, before: 0, after: 0 })
  check(upstreamRan, 'a local Session read still reaches the upstream method')
  check(calls.length === 0, 'and asks no node', String(calls.length))
}

// ---- `attach` pumps the uplink in both directions ------------------------
// This is the only endpoint that owns two directions at once, and the upstream
// body must never run: it would take `invocation.uplink()` a second time and throw.
{
  const uplinkItems = []
  let closed = false
  const gateway = {
    calls: [],
    async call() { throw new Error('attach is a stream, not a call') },
    async openStream(endpoint, args, handlers) {
      this.calls.push({ endpoint, args })
      // Frames only; the node keeps the attachment open until the browser is done,
      // which is what makes the uplink direction observable.
      handlers.onFrame({ type: 'snapshot', sequence: 0, screen: 'node screen', info: { id: args.id }, writable: true })
      handlers.onFrame({ type: 'output', sequence: 1, data: 'hello' })
      return {
        close: () => { closed = true },
        send: value => { uplinkItems.push(value); return true },
        endUplink: () => { uplinkItems.push('END') },
      }
    },
  }
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })

  class FakeTerminalController {
    attach() { throw new Error('the upstream attach must never run for a remote Session') }
  }
  const service = new FakeTerminalController()
  decorateTerminalController(service, router)

  // Stand in for the Gateway's call context: `this.ctx.invocation` is the call.
  const browser = [{ type: 'write', sequence: 1, data: 'x' }]
  const fakeThis = {
    ctx: {
      invocation: {
        uplink: () => (async function* () { yield* browser })(),
      },
    },
  }
  const stream = service.attach.call(fakeThis, { id: WRAPPED }, 't-node', undefined)
  const seen = []
  // Consume two frames, then stop — like a user closing the terminal window. The
  // uplink pump has to have received the browser's input by then.
  const iterator = stream[Symbol.asyncIterator]()
  seen.push((await iterator.next()).value)
  seen.push((await iterator.next()).value)
  await new Promise(resolve => setTimeout(resolve, 50))
  await iterator.return()
  check(seen.some(frame => frame.type === 'snapshot'), 'the node snapshot reaches the browser',
    JSON.stringify(seen).slice(0, 90))
  check(seen.some(frame => frame.type === 'output' && frame.data === 'hello'),
    'and so does its output')
  check(gateway.calls[0]?.endpoint === 'terminal/attach', 'the node was asked to attach')
  check(gateway.calls[0]?.args.agentId === SESSION, 'with its own agent identity')
  check(gateway.calls[0]?.args.id === 't-node', 'and the terminal id unchanged')
  check(uplinkItems[0]?.data === 'x', 'browser input reaches the node',
    JSON.stringify(uplinkItems))
  check(uplinkItems.at(-1) === 'END', 'and the uplink is half-closed, not cancelled')
  check(closed, 'the node stream is closed when the browser stops consuming')

  // A local attachment still reaches the upstream body (which here throws, proving
  // it was called).
  let threw
  try {
    await service.attach({ id: 'session-local' }, 't-1', undefined)
  } catch (error) {
    threw = error.message
  }
  check(String(threw).includes('upstream attach'), 'a local attach reaches the upstream method', threw)
}

// ---- the merged control stream emits ONE baseline ------------------------
// Both halves speak `baseline`, and a client treats any baseline as "this is now
// the whole picture". Emitting the remote one and then the local one leaves the
// remote rows wiped out — correct for one frame, empty afterwards, which reads as
// "remote projections never worked".
{
  const remoteFrames = []
  const control = {
    baselineFrame: () => ({
      type: 'baseline',
      value: { projections: { [`rnh_${NODE}_${SESSION}`]: { asOfSeq: 1, values: { title: 'remote' } } } },
    }),
    subscribe: listener => {
      remoteFrames.push(listener)
      return () => {}
    },
  }
  async function * local() {
    yield { type: 'baseline', value: { projections: { 'session-local': { asOfSeq: 2, values: { title: 'local' } } } } }
    yield { type: 'projection', sessionId: 'session-local', seq: 3, changes: [] }
  }
  const frames = []
  for await (const frame of mergeControlStream(local(), control, undefined)) {
    frames.push(frame)
    if (frames.length === 3) break
  }
  const baselines = frames.filter(frame => frame.type === 'baseline')
  check(baselines.length === 1, 'exactly one baseline reaches the client',
    String(baselines.length))
  const blocks = baselines[0]?.value?.projections ?? {}
  check(Object.keys(blocks).length === 2, 'the baseline carries both halves',
    Object.keys(blocks).join(','))
  check(blocks[`rnh_${NODE}_${SESSION}`]?.values?.title === 'remote', 'the remote block survives')
  check(blocks['session-local']?.values?.title === 'local', 'the local block survives')
  check(frames.some(frame => frame.type === 'projection'), 'projection frames still stream through')

  // A remote baseline change after the opening frame re-emits the merged whole,
  // which is how a node that connects mid-session appears without a reload.
  remoteFrames.length = 0
  const remerge = []
  const iterator = mergeControlStream(local(), control, undefined)[Symbol.asyncIterator]()
  remerge.push(await iterator.next())
  remerge.push(await iterator.next())
  await iterator.return()
  check(remerge.length === 2, 'the merged stream can be advanced and closed',
    String(remerge.length))
}

// ---- a local call keeps the upstream method's SHAPE, not only its value ----
// Measured 2026-11-19 on 0.2.2-rc.5: every `*Endpoint` wrapper was an `async`
// function, so a local call came back as a promise. Three routed services are
// synchronous and their in-process callers do not await them:
//
//   dsh-tool-goal   goalValue(ctx.goals.create(agent, …))  — read .id/.revision
//   dsh-tool-goal   goals.get(agent)                       — read .phase
//   dsh-command-goal ctx.goals.create(invocation.agent, …)  — passed straight to a renderer
//
// `goals.create` also throws synchronously when a goal already exists. Under the
// `async` wrapper that throw became a rejected promise nobody awaited, which the
// Host's `unhandledRejection` handler turned into
// `dsh: fatal load failure: GoalError: goal "goal-…" already exists with phase
// "active"` and then `process.exit(1)` — the whole desktop app exited.
{
  const { gateway } = fakeGateway(NODE, {})
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })

  /** Upstream-shaped `goals`: every method synchronous, `create` throws on a duplicate. */
  class FakeGoals {
    constructor() { this.current = undefined }
    get(agent) { return this.current === undefined ? undefined : { ...this.current, forAgent: agent?.id } }
    create(agent, request) {
      if (this.current !== undefined) {
        throw Object.assign(new Error('goal "goal-1" already exists with phase "active"'), { code: 'GOAL_ALREADY_EXISTS' })
      }
      this.current = { id: 'goal-1', revision: 1, objective: request.objective, phase: 'active' }
      return { ...this.current, forAgent: agent?.id }
    }
  }

  const { decorateGoals } = await import('../src/host/decorators-extra.js')
  const service = new FakeGoals()
  decorateGoals(service, router)

  // The wrapper itself must not be an `async` function: `constructor.name` is the
  // cheapest structural proof, and it is what `Object.prototype.toString` reports.
  check(service.get.constructor.name === 'Function', 'a routed sync method is not an async function', service.get.constructor.name)

  // The value must arrive without an await, and it must be the goal itself.
  const created = service.create({ id: 'session-local' }, { objective: 'ship it' })
  check(created !== null && typeof created === 'object' && typeof created.then !== 'function',
    'a local goals.create returns the goal itself, not a promise')
  check(created.id === 'goal-1' && created.revision === 1 && created.phase === 'active',
    'and every field goalValue reads is present', JSON.stringify(created))
  check(created.forAgent === 'session-local', 'the upstream method really ran', String(created.forAgent))

  // The synchronous throw has to stay synchronous. A promise rejection here is what
  // killed the app: nothing awaited it, and the Host exits on an unhandled rejection.
  let thrown
  try {
    service.create({ id: 'session-local' }, { objective: 'again' })
  } catch (error) {
    thrown = error
  }
  check(thrown?.code === 'GOAL_ALREADY_EXISTS', 'a local goals.create throws synchronously', String(thrown?.code))
  check(thrown instanceof Error && typeof thrown.then !== 'function', 'the throw is an Error, not a rejected promise')

  // `get` is the read the goal bar makes on every render.
  const read = service.get({ id: 'session-local' })
  check(read !== null && typeof read === 'object' && typeof read.then !== 'function',
    'a local goals.get returns the view itself')
  check(read.phase === 'active', 'and the goal bar can read its phase', String(read.phase))
}

// ---- a stream endpoint stays a stream, not a promise ----------------------
{
  const { gateway } = fakeGateway(NODE, {
    'session/follow': [{ type: 'snapshot', header: { id: SESSION }, records: [] }],
  })
  const router = new Router({ rnh: fakeRnh(NODE, gateway) })
  const { decorateJobController } = await import('../src/host/decorators.js')

  class FakeJobs {
    list(request) { return (async function* () { yield { type: 'rows', local: request.sessionId } })() }
    follow(request) { return (async function* () { yield { type: 'opened', local: request.sessionId } })() }
  }
  const service = new FakeJobs()
  decorateJobController(service, router)
  const stream = service.list({ sessionId: 'session-local' })
  check(typeof stream?.[Symbol.asyncIterator] === 'function',
    'a local job list returns the upstream stream, not a promise wrapping it')
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
