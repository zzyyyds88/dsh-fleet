/**
 * Relay every connected node's forwarded Host events into this Host's own bus.
 *
 * A merged `session/list` answer is a *snapshot*. The sidebar is not built from
 * snapshots alone: the client keeps a live picture by subscribing to five Host
 * events (`api-session/added`, `/removed`, `/status`, `/activity`, `/error`), and
 * a Session row that never receives them stays frozen — no title, no running
 * spinner, no new row until something else forces a full list pull.
 *
 * Local Sessions get those events from the local `SessionController`. A remote
 * Session is not a local Session, so nothing local ever emits them for it. This
 * module is the missing half: it opens each node's forwarded-event stream
 * (`$events`, the one endpoint the Gateway owns rather than a controller) and
 * re-emits what arrives on this Host, with identities wrapped exactly the way
 * `session/list` and `workspace/follow` wrap them.
 *
 * That re-emit is the whole trick, and it is why no browser-side change is
 * needed: upstream's `api-remotes` already forwards these events to every
 * attached client, so a wrapped `api-session/added` travels to the sidebar
 * through the same pipe a local one does.
 *
 * Scoped waterfalls (`approval/request`, `user-questions/request`) arrive on the
 * same stream. They are answered with `next` — the node's own default — because
 * this Host has no local Agent to scope the question to, and an unanswered
 * waterfall does not fail: it waits forever, which would wedge the remote turn.
 *
 * @module @local/dsh-fleet/host/remote-events
 */

/**
 * The forwarded events a remote Session row needs in order to stay live.
 *
 * Deliberately a closed list. Re-emitting an event this Host also emits locally
 * is safe (the client merges by identity), but re-emitting an event this Host
 * would have to *interpret* is not: an unlisted event would reach consumers that
 * assume a local Agent behind it.
 */
export const RELAYED_EVENTS = Object.freeze([
  'api-session/added',
  'api-session/removed',
  'api-session/status',
  'api-session/activity',
  'api-session/error',
])

/**
 * The Gateway's own stream / result endpoints.
 *
 * These are not `<namespace>/<method>` names on a controller: the Gateway
 * intercepts them before endpoint resolution. `$events` streams, `$events/result`
 * is an ordinary unary call that answers one pending waterfall.
 */
const EVENT_STREAM_ENDPOINT = '$events'
const EVENT_RESULT_ENDPOINT = '$events/result'

/** One node's forwarded-event stream. */
class NodeEvents {
  /**
   * @param {string} nodeId
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   * @param {{ emit: (event: string, args: unknown[]) => void, log: (message: string) => void }} sink
   */
  constructor(nodeId, gateway, sink) {
    this.nodeId = nodeId
    this.gateway = gateway
    this.sink = sink
    /** @type {{ close: () => void } | undefined} */
    this.stream = undefined
    /** The Client generation a waterfall result must quote. */
    this.clientId = undefined
    this.opening = undefined
    this.closed = false
  }

  open() {
    if (this.stream !== undefined || this.opening !== undefined) return this.opening ?? Promise.resolve()
    this.opening = this.gateway.openStream(EVENT_STREAM_ENDPOINT, {}, {
      onFrame: value => this.#onFrame(value),
      onEnd: () => {
        // The carrier ended. Stop attributing anything to the old client id;
        // `sync()` reopens on the next fleet change.
        this.stream = undefined
        this.clientId = undefined
      },
    }).then(stream => {
      this.stream = stream
      this.opening = undefined
      return stream
    }).catch(error => {
      this.opening = undefined
      this.sink.log(`[${this.nodeId}] cannot follow node events: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.opening
  }

  close() {
    this.closed = true
    try { this.stream?.close() } catch { /* already closing */ }
    this.stream = undefined
    this.clientId = undefined
  }

  #onFrame(value) {
    if (this.closed) return
    const frame = value
    if (frame === null || typeof frame !== 'object') return
    const type = Reflect.get(frame, 'type')
    if (type === 'ready') {
      const clientId = Reflect.get(frame, 'clientId')
      this.clientId = typeof clientId === 'string' ? clientId : undefined
      return
    }
    if (type === 'waterfall') {
      void this.#decline(frame)
      return
    }
    if (type !== 'emit') return
    const event = Reflect.get(frame, 'event')
    if (typeof event !== 'string' || !RELAYED_EVENTS.includes(event)) return
    const args = Reflect.get(frame, 'args')
    if (!Array.isArray(args)) return
    this.sink.emit(event, args)
  }

  /**
   * Answer one scoped waterfall with `next`, which is the node's own default.
   *
   * The result is an ordinary RPC on the same Gateway: `$events/result` carries
   * the client and event identities the node handed us. A failure here is logged
   * and dropped — retrying cannot help, and throwing into the frame callback
   * would take the whole stream down.
   */
  async #decline(frame) {
    const clientId = this.clientId
    const eventId = Reflect.get(frame, 'eventId')
    if (clientId === undefined || typeof eventId !== 'string') return
    try {
      await this.gateway.call(EVENT_RESULT_ENDPOINT, {
        clientId,
        eventId,
        outcome: { kind: 'next' },
      })
    } catch (error) {
      this.sink.log(`[${this.nodeId}] could not decline ${String(Reflect.get(frame, 'event'))}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Every node's forwarded-event stream, feeding this Host's own event bus. */
export class RemoteEvents {
  /**
   * @param {import('./fleet.js').Fleet} fleet
   * @param {import('./router.js').Router} router
   * @param {{ emit: (event: string, args: unknown[]) => void, log?: (message: string) => void }} sink
   */
  constructor(fleet, router, sink) {
    this.fleet = fleet
    this.router = router
    this.emit = sink.emit
    this.log = sink.log ?? (() => {})
    /** @type {Map<string, NodeEvents>} */
    this.nodes = new Map()
    this.disposed = false
  }

  /**
   * Bring the stream set in line with the fleet.
   *
   * Idempotent and cheap: called on every fleet lifecycle change, it opens a
   * stream for a node that just became routable and drops one that left.
   */
  sync() {
    if (this.disposed) return
    const routable = this.fleet.routable()
    const live = new Set(routable.map(runtime => runtime.record.id))
    for (const [nodeId, node] of [...this.nodes]) {
      if (live.has(nodeId)) continue
      node.close()
      this.nodes.delete(nodeId)
    }
    for (const runtime of routable) {
      const nodeId = runtime.record.id
      if (this.nodes.has(nodeId)) continue
      const node = new NodeEvents(nodeId, runtime.gateway, {
        emit: (event, args) => this.#relay(nodeId, event, args),
        log: this.log,
      })
      this.nodes.set(nodeId, node)
      void node.open()
    }
  }

  /** Close every stream. */
  dispose() {
    this.disposed = true
    for (const node of this.nodes.values()) node.close()
    this.nodes.clear()
  }

  /**
   * Re-emit one node event locally with this Host's identity encoding.
   *
   * Wrapping is `Router.toLocal`, the same walk `session/list` uses, so a remote
   * identity reads the same whether it arrived in a snapshot or in an event.
   */
  #relay(nodeId, event, args) {
    if (this.disposed) return
    const wrapped = args.map(argument => this.router.toLocal(argument, nodeId))
    try {
      this.emit(event, wrapped)
    } catch (error) {
      // A listener throwing must not take the node stream down with it.
      this.log(`[${nodeId}] relaying ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
