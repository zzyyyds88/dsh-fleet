/**
 * Keep remote Sessions' *projections* live in every attached client.
 *
 * `session/control` is the stream that carries per-Session projection state: the
 * title, the model selection, the permission preset, the pending-input flags, the
 * subagent roster. Upstream's client half keeps one of these per connection and
 * treats its opening frame as the authoritative baseline, then applies
 * `projection` frames by ascending seq.
 *
 * Local Sessions are already in that stream. A remote Session is not a local
 * Session, so without this module its projections never move: a title the node's
 * brain wrote after the first turn would stay "New Session" in the sidebar until
 * something forced a full list pull.
 *
 * Two differences from `RemoteWorkspaces` shape the design:
 *
 *   - the control stream is **per consumer** upstream, and a client can open
 *     several (one per connection generation). So the node streams are owned once
 *     here and fanned out, instead of being opened per consumer.
 *   - a client treats every `baseline` frame as replace-your-picture, so this
 *     module can re-publish one whenever the node set changes — which is exactly
 *     what makes a node connecting mid-session appear without a page reload.
 *
 * @module @local/dsh-fleet/host/remote-control
 */
import { AsyncQueue, decodeRemoteId, encodeRemoteId } from './routing.js'

/** One node's control stream, reduced to the two frame kinds that matter. */
class NodeControl {
  /**
   * @param {string} nodeId
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   * @param {(node: NodeControl, frame: unknown) => void} onFrame
   */
  constructor(nodeId, gateway, onFrame) {
    this.nodeId = nodeId
    this.gateway = gateway
    this.onFrame = onFrame
    /** @type {Record<string, unknown> | undefined} */
    this.projections = undefined
    /** @type {{ close: () => void } | undefined} */
    this.stream = undefined
    this.closed = false
  }

  async open() {
    if (this.stream !== undefined || this.closed) return
    try {
      this.stream = await this.gateway.openStream('session/control', {}, {
        onFrame: value => {
          if (this.closed) return
          const frame = value
          if (frame === null || typeof frame !== 'object') return
          const type = Reflect.get(frame, 'type')
          if (type === 'baseline') {
            const value = Reflect.get(frame, 'value')
            const projections = Reflect.get(value ?? {}, 'projections')
            this.projections = projections !== null && typeof projections === 'object' ? projections : {}
            this.onFrame(this, frame)
            return
          }
          if (type === 'projection') {
            this.onFrame(this, frame)
          }
        },
        onEnd: () => {
          this.stream = undefined
        },
      })
    } catch {
      // A node that cannot stream control contributes no projections; the list
      // snapshot still carries whatever that node last reported.
      this.stream = undefined
    }
  }

  close() {
    this.closed = true
    try { this.stream?.close() } catch { /* already closing */ }
    this.stream = undefined
    this.projections = undefined
  }
}

/** The merged projection picture across this Host and every connected node. */
export class RemoteControl {
  /**
   * @param {import('./fleet.js').Fleet} fleet
   * @param {import('./router.js').Router} router
   * @param {(message: string) => void} [log]
   */
  constructor(fleet, router, log = () => {}) {
    this.fleet = fleet
    this.router = router
    this.log = log
    /** @type {Map<string, NodeControl>} */
    this.nodes = new Map()
    /** @type {Set<(frame: unknown) => void>} */
    this.subscribers = new Set()
    this.disposed = false
  }

  /** Bring the node set in line with the fleet. */
  sync() {
    if (this.disposed) return
    const routable = this.fleet.routable()
    const live = new Set(routable.map(runtime => runtime.record.id))
    let changed = false
    for (const [nodeId, node] of [...this.nodes]) {
      if (live.has(nodeId)) continue
      node.close()
      this.nodes.delete(nodeId)
      changed = true
    }
    for (const runtime of routable) {
      const nodeId = runtime.record.id
      if (this.nodes.has(nodeId)) continue
      const node = new NodeControl(nodeId, runtime.gateway, (owner, frame) => this.#onNodeFrame(owner, frame))
      this.nodes.set(nodeId, node)
      void node.open()
      changed = true
    }
    if (changed) this.#publishBaseline()
  }

  /**
   * The union baseline: every node's blocks, keyed by wrapped identity.
   * @returns {{ type: 'baseline', value: { projections: Record<string, unknown> } }}
   */
  baselineFrame() {
    /** @type {Record<string, unknown>} */
    const projections = {}
    for (const node of this.nodes.values()) {
      if (node.projections === undefined) continue
      for (const [sessionId, block] of Object.entries(node.projections)) {
        projections[encodeRemoteId(node.nodeId, sessionId)] = this.router.toLocal(block, node.nodeId)
      }
    }
    return { type: 'baseline', value: { projections } }
  }

  /** Subscribe to merged frames; returns the unsubscribe. */
  subscribe(listener) {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  /** Close every node stream. */
  dispose() {
    this.disposed = true
    for (const node of this.nodes.values()) node.close()
    this.nodes.clear()
    this.subscribers.clear()
  }

  #onNodeFrame(node, frame) {
    if (this.disposed) return
    // A node baseline replaces that node's blocks, so the whole union has to be
    // republished; a projection frame travels alone.
    if (Reflect.get(frame, 'type') === 'baseline') {
      this.#publishBaseline()
      return
    }
    this.#publish(this.router.toLocal(frame, node.nodeId))
  }

  #publishBaseline() {
    this.#publish(this.baselineFrame())
  }

  #publish(frame) {
    for (const listener of [...this.subscribers]) {
      try { listener(frame) } catch { /* a consumer must not break the feed */ }
    }
  }
}

/**
 * Merge this Host's own control stream with the remote projection picture.
 *
 * The local generation is consumed exactly as upstream would consume it, so a
 * local Session behaves identically; every remote frame is appended as it
 * arrives. A remote `baseline` is re-published whenever the node set changes, and
 * the client treats that as "replace the remote half", which is what makes a node
 * that connects mid-session show up without a reload.
 *
 * @param {AsyncIterable<unknown>} local
 * @param {import('./remote-control.js').RemoteControl} control
 * @param {AbortSignal | undefined} signal
 * @returns {AsyncIterable<unknown>}
 */
export function mergeControlStream(local, control, signal) {
  return {
    [Symbol.asyncIterator]() {
      const queue = new AsyncQueue()
      let stopped = false
      const unsubscribe = control.subscribe(frame => {
        if (!stopped) queue.push(frame)
      })
      // The remote half's opening baseline. Pushed first so a client that reads a
      // single frame before the local baseline still has the remote rows.
      queue.push(control.baselineFrame())
      const onAbort = () => { stopped = true }
      signal?.addEventListener('abort', onAbort, { once: true })

      const pump = async () => {
        try {
          for await (const frame of local) {
            if (stopped) return
            queue.push(frame)
          }
        } catch (error) {
          queue.fail(error)
          return
        } finally {
          unsubscribe()
          signal?.removeEventListener('abort', onAbort)
        }
        // The local generation ended: this Host is shutting down.
        queue.end()
      }
      void pump()

      return {
        next: () => queue.next(),
        return: async () => {
          stopped = true
          unsubscribe()
          signal?.removeEventListener('abort', onAbort)
          queue.end()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/** Whether an id names a Session this Host does not own. */
export function isRemoteSessionId(value) {
  return decodeRemoteId(value) !== undefined
}
