/**
 * The identity-carrying namespaces added after the four main ones, driven against a fake
 * fleet and a fake gateway.
 *
 * Each of these has a different shape, and getting the shape wrong is invisible: the call
 * still returns *something*, it is just this Host's answer instead of the node's. So each
 * group asserts the two things that are actually decided by the decorator:
 *
 *   1. a local call reaches the upstream implementation untouched;
 *   2. a remote call becomes one gateway call to the owning node, with the node's own
 *      identity in the payload and the result wrapped back.
 *
 * `schedule` is the odd one: its entries are Host-wide, so `catalog`/`list` merge and only
 * the per-entry verbs route. That difference is asserted rather than assumed.
 */
import {
  decorateCommands,
  decorateFileReferences,
  decorateGoals,
  decorateMessageFeedback,
  decorateSchedule,
  decorateSessionReferenceResolver,
  decorateSubagents,
  decorateUserQuestions,
} from '../src/host/decorators-extra.js'
import { Router } from '../src/host/router.js'

const nodeA = 'n0123456789ab'
const remoteSession = `fleet_${nodeA}_session-11111111-2222-3333-4444-555555555555`
const localSession = 'session-99999999-8888-7777-6666-555555555555'
const remoteChild = `fleet_${nodeA}_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`

let failed = 0
const checks = []
function ok(condition, message, detail) {
  checks.push({ condition, message })
  if (!condition) failed += 1
  const mark = condition ? 'ok  ' : 'FAIL'
  console.log(`[routing-extra] ${mark} ${message}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** One routable node whose gateway records every call. */
function fakeFleet() {
  const calls = []
  const runtime = {
    record: { id: nodeA, name: 'probe' },
    routable: true,
    gateway: {
      async call(endpoint, args) {
        calls.push({ endpoint, args })
        return { ok: true, value: { from: endpoint } }
      },
    },
  }
  return {
    calls,
    list: () => [runtime],
    routable: () => [runtime],
    get: id => (id === nodeA ? runtime : undefined),
  }
}

/**
 * A service stand-in whose methods only record that they ran.
 *
 * Deliberately **not** `async`: most of the namespaces this file covers are synchronous
 * upstream (`goals/*`, `userQuestions/answer`, `commands/list`), and an async stand-in
 * hides the thing that broke on 2026-11-19 — an `async` wrapper turned a synchronous
 * return into a promise and a synchronous throw into a rejected promise nobody awaited,
 * which the Host's `unhandledRejection` handler turned into `process.exit(1)`. Tests that
 * want to await a non-promise can; `await` accepts a plain value.
 */
function fakeService(methods) {
  const service = {}
  for (const name of methods) {
    Object.defineProperty(service, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (...args) => ({ local: name, args }),
    })
  }
  return service
}

/** A placeholder `Agent` as `host/lookups.js` builds it. */
const agent = id => ({ id, ctx: {}, session: undefined })

// ---- goals: identity is the Agent, result is a GoalView --------------------

{
  const fleet = fakeFleet()
  const router = new Router({ fleet })
  const service = fakeService(['get', 'edit', 'pause', 'resume', 'complete', 'clear', 'create'])
  decorateGoals(service, router)

  const local = await service.get(agent(localSession))
  ok(local.local === 'get', 'a local goal read reaches the upstream method', local.local)
  ok(fleet.calls.length === 0, 'and calls nothing on the network', String(fleet.calls.length))

  const remote = await service.get(agent(remoteSession))
  ok(fleet.calls.length === 1, 'a remote goal read makes one call', String(fleet.calls.length))
  ok(fleet.calls[0].endpoint === 'goals/get', 'to goals/get', fleet.calls[0].endpoint)
  ok(fleet.calls[0].args.agentId === 'session-11111111-2222-3333-4444-555555555555',
    'with the node own Session id, not the wrapped one', String(fleet.calls[0].args.agentId))
  ok(remote?.from === 'goals/get', 'and the answer comes from the node', String(remote?.from))

  // `edit` has two trailing positional arguments; both have to reach the node in order.
  await service.edit(agent(remoteSession), { id: 'g', revision: 2 }, { objective: 'x' })
  const edit = fleet.calls.at(-1)
  ok(edit.endpoint === 'goals/edit', 'goals/edit routes', edit.endpoint)
  ok(edit.args.ref?.revision === 2, 'its ref argument is forwarded verbatim', JSON.stringify(edit.args.ref))
  ok(edit.args.request?.objective === 'x', 'and so is its request', JSON.stringify(edit.args.request))
}

// ---- userQuestions: a bool, and a stream ---------------------------------

{
  const fleet = fakeFleet()
  const router = new Router({ fleet })
  const service = fakeService(['answer', 'attachWait'])
  decorateUserQuestions(service, router)

  await service.answer(agent(remoteSession), 'call-1', { kind: 'result', value: 'yes' })
  const answered = fleet.calls.at(-1)
  ok(answered.endpoint === 'userQuestions/answer', 'an answer routes to the node',
    answered.endpoint)
  ok(answered.args.callId === 'call-1', 'with the call id', String(answered.args.callId))
  ok(answered.args.agentId.startsWith('session-'), 'and the node own Session id',
    String(answered.args.agentId))

  // The stream must be opened as a stream: awaiting it would return the iterable itself and
  // the question card's countdown would never start.
  let opened
  const streamService = fakeService(['attachWait'])
  const streamFleet = fakeFleet()
  streamFleet.get = id => (id === nodeA ? {
    record: { id: nodeA, name: 'probe' },
    routable: true,
    gateway: {
      async call() { throw new Error('a stream endpoint must not be called as unary') },
      openStream(endpoint, args, handlers) {
        opened = { endpoint, args }
        // A node stream that simply ends: `remoteIterable` must then settle the local
        // iterator instead of leaving the caller waiting on a handle nobody will close.
        queueMicrotask(() => handlers.onEnd(undefined))
        return Promise.resolve({
          send: () => true,
          close: () => {},
          endUplink: () => {},
        })
      },
    },
  } : undefined)
  streamFleet.routable = () => [streamFleet.get(nodeA)]
  decorateUserQuestions(streamService, new Router({ fleet: streamFleet }))
  const iterable = streamService.attachWait(agent(remoteSession), 'call-2', undefined)
  ok(typeof iterable?.[Symbol.asyncIterator] === 'function', 'attachWait returns a stream')
  // The node stream is opened lazily, on the first `next()` — that is the property that makes
  // an unread stream cost nothing, so the assertion drives one step rather than inspecting it.
  const first = await iterable[Symbol.asyncIterator]().next()
  ok(opened?.endpoint === 'userQuestions/attachWait', 'and opens the node stream on first read',
    String(opened?.endpoint))
  ok(opened?.args.callId === 'call-2', 'with the call id', String(opened?.args.callId))
  ok(first?.done === true, 'the stream settles once the node ends it', JSON.stringify(first))
}

// ---- subagents: a child Session is a bare uuid ---------------------------

{
  const fleet = fakeFleet()
  const router = new Router({ fleet })
  const service = fakeService(['prompt', 'interruptByUser'])
  decorateSubagents(service, router)

  await service.prompt({ childSessionId: remoteChild, requestId: 'r', content: [] })
  const prompt = fleet.calls.at(-1)
  ok(prompt.endpoint === 'subagents/prompt', 'a prompt to a remote child routes', prompt.endpoint)
  ok(prompt.args.request.childSessionId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'with the child bare uuid, which is what the node minted', String(prompt.args.request.childSessionId))

  await service.interruptByUser(remoteChild)
  const interrupt = fleet.calls.at(-1)
  ok(interrupt.endpoint === 'subagents/interruptByUser', 'an interrupt routes too', interrupt.endpoint)
  ok(interrupt.args.childSessionId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'as the child id under the wire field the descriptor names, not a request wrapper',
    JSON.stringify(interrupt.args))
}

// ---- commands / fileReferences / sessionReferenceResolver -----------------

{
  const fleet = fakeFleet()
  const router = new Router({ fleet })
  const commands = fakeService(['list', 'execute'])
  decorateCommands(commands, router)

  await commands.list(agent(remoteSession))
  ok(fleet.calls.at(-1).endpoint === 'commands/list', 'the command list comes from the node',
    fleet.calls.at(-1).endpoint)
  await commands.execute(agent(remoteSession), '/compact', [], undefined)
  const run = fleet.calls.at(-1)
  ok(run.endpoint === 'commands/execute', 'and so does running one', run.endpoint)
  ok(run.args.line === '/compact', 'with the typed line', String(run.args.line))
  ok(run.args.agentId.startsWith('session-'), 'and the node own Session id', String(run.args.agentId))

  const files = fakeService(['list'])
  decorateFileReferences(files, router)
  await files.list(agent(remoteSession), '@src/')
  const refs = fleet.calls.at(-1)
  ok(refs.endpoint === 'fileReferences/list', 'the @-mention list comes from the node', refs.endpoint)
  ok(refs.args.query === '@src/', 'with the typed query', String(refs.args.query))

  const refs2 = fakeService(['candidates'])
  decorateSessionReferenceResolver(refs2, router)
  await refs2.candidates(agent(remoteSession), 'abc')
  ok(fleet.calls.at(-1).endpoint === 'sessionReferenceResolver/candidates',
    'and so does the Session mention list', fleet.calls.at(-1).endpoint)
}

// ---- messageFeedback: identity lives in the request ----------------------

{
  const fleet = fakeFleet()
  const router = new Router({ fleet })
  const service = fakeService(['list', 'put', 'delete'])
  decorateMessageFeedback(service, router)

  const request = { sessionId: remoteSession, messageId: 'm1', rating: 'positive', ifVersion: null }
  await service.put(request)
  const put = fleet.calls.at(-1)
  ok(put.endpoint === 'messageFeedback/put', 'feedback reaches the node', put.endpoint)
  ok(put.args.request.sessionId === 'session-11111111-2222-3333-4444-555555555555',
    'rebound to the node own Session id', String(put.args.request.sessionId))
  ok(put.args.request.messageId === 'm1', 'and every other field is forwarded', String(put.args.request.messageId))

  // A local call must reach upstream with the request untouched.
  const before = fleet.calls.length
  const local = await service.list({ sessionId: localSession })
  ok(local.local === 'list', 'a local feedback read reaches the upstream method', local.local)
  ok(fleet.calls.length === before, 'without any network call')
}

// ---- schedule: merged lists, routed per-entry verbs ----------------------

{
  const fleet = fakeFleet()
  const router = new Router({ fleet })
  const service = fakeService(['catalog', 'list', 'history', 'view', 'edit', 'run', 'create', 'deleteInactive'])
  // The fake gateway's answer for the merged reads has to look like the real shape.
  fleet.get = id => (id === nodeA ? {
    record: { id: nodeA, name: 'probe' },
    routable: true,
    gateway: {
      async call(endpoint, args) {
        fleet.calls.push({ endpoint, args })
        if (endpoint === 'schedule/catalog') return { ok: true, value: [{ id: 'remote-task' }] }
        if (endpoint === 'schedule/list') return { ok: true, value: { items: [{ id: 'remote-task' }], total: 1 } }
        return { ok: true, value: { from: endpoint } }
      },
    },
  } : undefined)
  // Local answers: the Host has one task of its own.
  service.catalog = async () => [{ id: 'local-task' }]
  service.list = async () => ({ items: [{ id: 'local-task' }], total: 1 })
  decorateSchedule(service, router)

  const catalog = await service.catalog()
  ok(Array.isArray(catalog) && catalog.length === 2, 'the catalog merges this Host and the node',
    JSON.stringify(catalog.map(row => row.id)))
  ok(catalog.some(row => row.id === 'local-task'), 'with the local task as it was')
  ok(catalog.some(row => row.id === `fleet_${nodeA}_remote-task`),
    'and the node task wrapped, which is the only way the browser can name it',
    JSON.stringify(catalog.map(row => row.id)))

  const list = await service.list({})
  ok(Array.isArray(list?.items) && list.items.length === 2, 'the list merges the same way',
    String(list?.items?.length))

  // Paging is answered over the merged rows, not forwarded.
  const paged = await service.list({ limit: 1, offset: 0 })
  ok(paged.items.length === 1, 'paging applies to the merged rows', String(paged.items.length))

  // A per-entry verb decodes the wrapped id and forwards the node's own.
  await service.view({ id: `fleet_${nodeA}_remote-task` })
  const viewed = fleet.calls.at(-1)
  ok(viewed.endpoint === 'schedule/view', 'viewing a remote task routes', viewed.endpoint)
  ok(viewed.args.request.id === 'remote-task', 'with the node own entry id', String(viewed.args.request.id))

  // `run` is the one a person presses; it must not fall through to a local "not found".
  await service.run({ id: `fleet_${nodeA}_remote-task` })
  ok(fleet.calls.at(-1).endpoint === 'schedule/run', 'running a remote task routes too',
    fleet.calls.at(-1).endpoint)

  // `create` names its destination, and the node needs its own id there.
  await service.create({
    title: 't', prompt: 'p', rrule: 'x', target: { kind: 'this_session', sessionId: remoteSession },
  })
  const created = fleet.calls.at(-1)
  ok(created.endpoint === 'schedule/create', 'creating for a remote Session routes', created.endpoint)
  ok(created.args.request.target.sessionId === 'session-11111111-2222-3333-4444-555555555555',
    'with the node own Session id as the destination',
    String(created.args.request.target.sessionId))

  // Cleanup runs on both sides: leaving the node's inactive entries behind means the next
  // merge shows tasks the page says cannot be deleted.
  const before = fleet.calls.length
  await service.deleteInactive()
  ok(fleet.calls.length > before, 'cleaning inactive tasks also asks the node',
    `${String(fleet.calls.length - before)} call(s)`)
}

console.log('')
if (failed > 0) {
  console.error(`[routing-extra] ${failed} of ${checks.length} checks failed`)
  process.exitCode = 1
} else {
  console.log(`[routing-extra] all ${checks.length} checks passed`)
}
