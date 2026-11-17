/**
 * Does a node's permission prompt actually reach this Host's browser?
 *
 * The whole feature rests on one shape: a `waterfall` frame from the node becomes a
 * pending entry in **this** Host's Gateway, the browser answers through
 * `$events/result`, and the answer travels back to the node as the same three-state
 * outcome upstream uses.
 *
 * This test builds a fake Gateway with the same three fields the real one has
 * (`pendingRemoteEvents`, `remoteEventClients`, `deliverRemoteEvent`,
 * `cancelRemoteEvent`, `hasLiveClient`) and drives the relay directly, so it can
 * assert the parts that are easy to get wrong and impossible to see in a passing
 * end-to-end run:
 *
 *   - with no browser attached, the node gets its own default *immediately* — an
 *     unanswered waterfall waits forever and would wedge the remote turn;
 *   - the wrapped `agentId` is what the browser sees, or the card lands on a Session
 *     that does not exist;
 *   - a real answer becomes `{kind:'result'}`, an unclaimed one becomes `{kind:'next'}`;
 *   - a node `cancel` frame withdraws the local card and sends nothing back.
 *
 * Run: `node test/waterfall-unit.mjs`
 */
import { RemoteWaterfalls, RELAYED_WATERFALLS } from '../src/host/remote-waterfall.js'
import { encodeRemoteId } from '../src/host/routing.js'

const log = message => process.stdout.write(`[waterfall-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const NODE = 'n0123456789ab'
const REMOTE_SESSION = 'session-11111111-2222-3333-4444-555555555555'
const WRAPPED = encodeRemoteId(NODE, REMOTE_SESSION)

/** A Gateway with exactly the surface the relay touches. */
class FakeHostGateway {
  constructor(options = {}) {
    this.pendingRemoteEvents = new Map()
    this.remoteEventClients = new Map()
    this.answers = options.answers ?? true
    this.cancelled = []
    this.delivered = []
  }

  hasLiveClient() {
    return this.answers
  }

  setLive(answers) {
    this.answers = answers
  }

  addClient(id) {
    const client = { id, answers: true, deliveries: new Map() }
    this.remoteEventClients.set(id, client)
    return client
  }

  deliverRemoteEvent(entry, client) {
    this.delivered.push({ eventId: entry.id, clientId: client.id, frame: entry.frame })
    entry.deliveries.add(client)
    client.deliveries.set(entry.id, entry)
  }

  cancelRemoteEvent(entry, reason) {
    this.cancelled.push({ eventId: entry.id, reason: String(reason?.message ?? reason) })
    this.pendingRemoteEvents.delete(entry.id)
    entry.source.reject(reason)
  }

  /** Answer one pending event the way the browser's `$events/result` would. */
  answer(eventId, outcome) {
    const entry = this.pendingRemoteEvents.get(eventId)
    if (entry === undefined) throw new Error(`no pending entry ${eventId}`)
    this.pendingRemoteEvents.delete(eventId)
    entry.source.resolve(outcome)
  }
}

/** A node Gateway that records what the relay sends back. */
class FakeNodeGateway {
  constructor() {
    this.replies = []
    this.calls = []
  }

  async call(endpoint, args) {
    this.calls.push({ endpoint, args })
    this.replies.push(args)
    return { ok: true, value: undefined }
  }
}

/** A Router stand-in: wrapping is the identity translation under test. */
const router = {
  toLocal(value, nodeId) {
    if (typeof value !== 'string') return value
    if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) return value
    return encodeRemoteId(nodeId, value)
  },
}

/** One runtime as `Fleet.routable()` reports it. */
const runtime = { record: { id: NODE, name: 'probe' }, gateway: new FakeNodeGateway() }

const frame = (overrides = {}) => ({
  type: 'waterfall',
  event: 'approval/request',
  eventId: 'ev-1',
  agentId: REMOTE_SESSION,
  request: { toolName: 'bash', callId: 'call-1', reason: 'runs outside the workspace' },
  ...overrides,
})

check(RELAYED_WATERFALLS.length === 2 && RELAYED_WATERFALLS.includes('approval/request'),
  'the relayed set is exactly the two scoped waterfalls', RELAYED_WATERFALLS.join(','))

// ---- 1. no browser: the node's own default applies, immediately ------------
{
  const host = new FakeHostGateway({ answers: false })
  const node = new FakeNodeGateway()
  const relay = new RemoteWaterfalls(
    { routable: () => [{ record: { id: NODE }, gateway: node }] },
    router,
    host,
    { log: () => {}, ttlMs: 5_000 },
  )
  relay.sync()
  const node1 = relay.forNode({ record: { id: NODE }, gateway: node })
  node1.ready('client-1')
  const started = Date.now()
  await node1.relay(frame())
  const elapsed = Date.now() - started
  check(elapsed < 1_000, 'an unanswered request is declined at once, not held open',
    `${String(elapsed)}ms`)
  check(host.pendingRemoteEvents.size === 0, 'and nothing is left pending in this Host')
  check(node.replies.length === 1 && node.replies[0].outcome.kind === 'next',
    'the node receives {kind:"next"}, so its own default runs',
    JSON.stringify(node.replies[0]?.outcome))
  check(node.calls.length === 1 && node.calls[0].endpoint === '$events/result',
    'and the reply is a `$events/result` call on the node', node.calls[0]?.endpoint)
  relay.dispose()
}

// ---- 2. a real answer round-trips, with a wrapped identity ----------------
{
  const host = new FakeHostGateway()
  const client = host.addClient('client-1')
  const node = new FakeNodeGateway()
  const relay = new RemoteWaterfalls(
    { routable: () => [{ record: { id: NODE }, gateway: node }] },
    router,
    host,
    { log: () => {}, ttlMs: 5_000 },
  )
  relay.sync()
  const node1 = relay.forNode({ record: { id: NODE }, gateway: node })
  node1.ready('client-1')

  const settled = node1.relay(frame())
  await sleep(20)
  check(host.pendingRemoteEvents.size === 1, 'the request is now pending in this Host')
  const delivered = host.delivered.at(-1)
  check(delivered !== undefined, 'and it was delivered to the owner client')
  check(delivered?.frame.agentId === WRAPPED,
    'the browser sees the wrapped Session identity, not the node one', delivered?.frame.agentId)
  check(delivered?.frame.event === 'approval/request', 'under the same event name')
  check(!Object.hasOwn(delivered?.frame.request ?? {}, 'agent'),
    'the frame carries no `agent` — the browser injects its own scope')
  check(!Object.hasOwn(delivered?.frame.request ?? {}, 'signal'),
    'and no `signal` either, for the same reason')

  host.answer('ev-1', { kind: 'result', value: 'allowed-once' })
  await settled
  check(node.replies.at(-1)?.outcome.kind === 'result',
    'an answer becomes {kind:"result"}', JSON.stringify(node.replies.at(-1)?.outcome))
  check(node.replies.at(-1)?.outcome.value === 'allowed-once', 'with the value the browser chose')
  check(node.replies.at(-1)?.clientId === 'client-1',
    'quoted against the node client generation that asked',
    node.replies.at(-1)?.clientId)
  check(host.pendingRemoteEvents.size === 0, 'and the pending entry is gone')
  void client
  relay.dispose()
}

// ---- 3. a node cancel withdraws the card and answers nothing --------------
{
  const host = new FakeHostGateway()
  host.addClient('client-1')
  const node = new FakeNodeGateway()
  const relay = new RemoteWaterfalls(
    { routable: () => [{ record: { id: NODE }, gateway: node }] },
    router,
    host,
    { log: () => {}, ttlMs: 5_000 },
  )
  relay.sync()
  const node1 = relay.forNode({ record: { id: NODE }, gateway: node })
  node1.ready('client-1')

  const settled = node1.relay(frame({ eventId: 'ev-2' }))
  await sleep(20)
  check(host.pendingRemoteEvents.has('ev-2'), 'the request is pending before the cancel')
  node1.cancelled('ev-2')
  await settled
  check(host.cancelled.length === 1, 'the local entry is cancelled (the card disappears)',
    String(host.cancelled.length))
  check(host.cancelled[0]?.eventId === 'ev-2', 'for the right request')
  const repliesForEv2 = node.replies.filter(reply => reply.eventId === 'ev-2')
  check(repliesForEv2.length === 0, 'and nothing is sent back to the node',
    `${String(repliesForEv2.length)} reply/replies`)
  relay.dispose()
}

// ---- 4. a request with no answer in time is handed back as `next` ---------
{
  const host = new FakeHostGateway()
  host.addClient('client-1')
  const node = new FakeNodeGateway()
  const relay = new RemoteWaterfalls(
    { routable: () => [{ record: { id: NODE }, gateway: node }] },
    router,
    host,
    { log: () => {}, ttlMs: 40 },
  )
  relay.sync()
  const node1 = relay.forNode({ record: { id: NODE }, gateway: node })
  node1.ready('client-1')
  const settled = node1.relay(frame({ eventId: 'ev-3' }))
  await sleep(120)
  await settled
  check(node.replies.at(-1)?.outcome.kind === 'next',
    'an expired request degrades to the node default',
    JSON.stringify(node.replies.at(-1)?.outcome))
  relay.dispose()
}

// ---- 5. an event the relay does not own is declined, not shown ------------
{
  const host = new FakeHostGateway()
  host.addClient('client-1')
  const node = new FakeNodeGateway()
  const relay = new RemoteWaterfalls(
    { routable: () => [{ record: { id: NODE }, gateway: node }] },
    router,
    host,
    { log: () => {}, ttlMs: 5_000 },
  )
  relay.sync()
  const node1 = relay.forNode({ record: { id: NODE }, gateway: node })
  node1.ready('client-1')
  host.delivered.length = 0
  await node1.relay(frame({ event: 'some-other/waterfall', eventId: 'ev-4' }))
  check(host.delivered.length === 0, 'an unlisted waterfall never reaches the browser')
  check(node.replies.at(-1)?.outcome.kind === 'next', 'and the node gets its default')
  relay.dispose()
}

// ---- 6. a disconnect withdraws every card it left behind ------------------
{
  const host = new FakeHostGateway()
  host.addClient('client-1')
  const node = new FakeNodeGateway()
  const relay = new RemoteWaterfalls(
    { routable: () => [{ record: { id: NODE }, gateway: node }] },
    router,
    host,
    { log: () => {}, ttlMs: 60_000 },
  )
  relay.sync()
  const node1 = relay.forNode({ record: { id: NODE }, gateway: node })
  node1.ready('client-1')
  const settled = node1.relay(frame({ eventId: 'ev-5' }))
  await sleep(20)
  node1.close()
  await settled
  check(host.cancelled.some(entry => entry.eventId === 'ev-5'),
    'a node going away cancels its pending cards instead of leaving them')
  relay.dispose()
}

// ---- 7. `user-questions/request` travels the same path --------------------
{
  const host = new FakeHostGateway()
  host.addClient('client-1')
  const node = new FakeNodeGateway()
  const relay = new RemoteWaterfalls(
    { routable: () => [{ record: { id: NODE }, gateway: node }] },
    router,
    host,
    { log: () => {}, ttlMs: 5_000 },
  )
  relay.sync()
  const node1 = relay.forNode({ record: { id: NODE }, gateway: node })
  node1.ready('client-1')
  const questions = {
    questions: [{ id: 'q1', question: 'which one?', options: [{ label: 'a' }, { label: 'b' }] }],
  }
  const settled = node1.relay(frame({ event: 'user-questions/request', eventId: 'ev-6', request: questions }))
  await sleep(20)
  check(host.delivered.at(-1)?.frame.event === 'user-questions/request',
    'the question sibling is relayed under its own name')
  check(host.delivered.at(-1)?.frame.request?.questions?.[0]?.id === 'q1',
    'with its payload intact')
  const answer = { answers: [{ id: 'q1', selected: ['a'] }] }
  host.answer('ev-6', { kind: 'result', value: answer })
  await settled
  check(node.replies.at(-1)?.outcome.value?.answers?.[0]?.selected?.[0] === 'a',
    'and the structured answer reaches the node unchanged',
    JSON.stringify(node.replies.at(-1)?.outcome.value))
  relay.dispose()
}

void runtime
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
