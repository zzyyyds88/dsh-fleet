/**
 * One node's Typert Gateway client.
 *
 * The remote brain is a full DSH Host listening on its own loopback. This class
 * is the local half of that relationship: it mints the browser cookie the remote
 * requires, issues unary RPC over pooled SSH channels, and keeps one stream
 * carrier open per node so `workspace/follow`, `session/follow` and
 * `session/events` reach local subscribers as ordinary event streams.
 *
 * Nothing here translates paths, mirrors files or synthesises results. Every
 * value crossing this boundary is the remote Host's own answer.
 *
 * @module @local/dsh-fleet/host/remote-gateway
 */
import { randomUUID } from 'node:crypto'
import { decodeGatewayAnswer } from './multipart.js'
import { cookiesOf, httpOverSsh, openChannel } from './ssh-http.js'
import { upgradeWebSocket } from './ws.js'

/** Endpoint that answers with the browser cookie when given the launch token. */
const TOKEN_PATH = token => `/?token=${encodeURIComponent(token)}`

/** Failure codes this client can produce before the remote even answers. */
export const GATEWAY_FAILURE = Object.freeze({
  OFFLINE: 'fleet/offline',
  AUTH: 'fleet/auth',
  CARRIER: 'fleet/carrier',
  TIMEOUT: 'fleet/timeout',
})

/** One in-flight logical stream. */
class LogicalStream {
  /**
   * @param {string} endpoint
   * @param {{ onFrame: (value: unknown) => void, onEnd: (failure?: unknown) => void }} handlers
   * @param {import('./ws.js').WebSocketClient | undefined} carrier
   */
  constructor(endpoint, handlers, carrier) {
    this.endpoint = endpoint
    this.handlers = handlers
    this.carrier = carrier
    this.id = `s-${randomUUID()}`
    this.closed = false
    /** Whether the uplink was already half-closed, so it is not sent twice. */
    this.uplinkEnded = false
  }

  /** Send one uplink item on this stream, if the carrier is still writable. */
  send(value) {
    if (this.closed || this.carrier === undefined) return false
    try {
      return this.carrier.send(JSON.stringify({ type: 'item', streamId: this.id, value }))
    } catch {
      return false
    }
  }

  /** Half-close the uplink: the node's `uplink()` iteration ends. Idempotent. */
  endUplink() {
    if (this.closed || this.uplinkEnded || this.carrier === undefined) return
    this.uplinkEnded = true
    try {
      this.carrier.send(JSON.stringify({ type: 'end', streamId: this.id }))
    } catch { /* the carrier is already gone */ }
  }

  close() {
    if (this.closed) return
    this.closed = true
    // Telling the node this stream is done matters for anything that holds a
    // resource on its side (a terminal attachment, a live follow). Without it the
    // node keeps the attachment until its own heartbeat gives up.
    if (this.carrier !== undefined) {
      try {
        this.carrier.send(JSON.stringify({ type: 'cancel', streamId: this.id }))
      } catch { /* the carrier is already gone */ }
    }
    this.handlers.onEnd()
  }

  /** The node ended this stream itself: drop it locally without telling it back. */
  finish() {
    if (this.closed) return
    this.closed = true
    this.handlers.onEnd()
  }
}

/** One node's gateway link: cookie, unary RPC, and the shared stream carrier. */
export class RemoteGateway {
  /**
   * @param {object} options
   * @param {import('../ssh/connection.js').SshConnection} options.connection
   * @param {() => ({ port: number, token: string } | undefined)} options.serving
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.connection = options.connection
    this.servingOf = options.serving
    this.log = options.log ?? (() => {})
    /** @type {string | undefined} */
    this.cookieValue = undefined
    /** @type {import('./ws.js').WebSocketClient | undefined} */
    this.carrier = undefined
    /** @type {Promise<import('./ws.js').WebSocketClient> | undefined} */
    this.carrierPending = undefined
    /** @type {Map<string, LogicalStream>} */
    this.streams = new Map()
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.waiters = new Map()
  }

  /** The endpoint facts of the resident host, or `undefined` while it is down. */
  serving() {
    return this.servingOf()
  }

  /** Drop cached auth and carrier state, e.g. after the node reconnects. */
  reset() {
    this.cookieValue = undefined
    const carrier = this.carrier
    this.carrier = undefined
    this.carrierPending = undefined
    if (carrier !== undefined) {
      try { carrier.close() } catch { /* already closing */ }
    }
    for (const stream of [...this.streams.values()]) {
      try { stream.close() } catch { /* already closing */ }
    }
    this.streams.clear()
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      this.waiters.delete(id)
      waiter.reject(Object.assign(new Error('the node went offline'), { code: GATEWAY_FAILURE.OFFLINE }))
    }
  }

  /**
   * Mint (or reuse) the browser cookie the remote application requires.
   *
   * A launch token is single-purpose: exchanging it at `/?token=` answers 303
   * with a v1 browser cookie. That cookie — not an API operator credential — is
   * what `authorizeIndex` and the `/api` interceptor accept, so every later
   * request carries it.
   * @returns {Promise<string>}
   */
  async cookie(force = false) {
    if (!force && this.cookieValue !== undefined) return this.cookieValue
    const serving = this.serving()
    if (serving === undefined) {
      throw Object.assign(new Error('this node is not serving yet'), { code: GATEWAY_FAILURE.OFFLINE })
    }
    const response = await httpOverSsh(this.connection, serving.port, { path: TOKEN_PATH(serving.token) })
    const cookies = cookiesOf(response.headers)
    if (cookies.length === 0) {
      throw Object.assign(
        new Error(`the remote answered HTTP ${String(response.status)} without issuing a session cookie`),
        { code: GATEWAY_FAILURE.AUTH },
      )
    }
    this.cookieValue = cookies.join('; ')
    return this.cookieValue
  }

  /**
   * One unary Gateway call, retried once against a fresh cookie when the remote
   * rejects the cached one.
   * @param {string} endpoint - e.g. `session/list`.
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string, details?: unknown } }>}
   */
  async call(endpoint, args = {}, signal) {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const serving = this.serving()
      if (serving === undefined) {
        throw Object.assign(new Error('this node is not serving yet'), { code: GATEWAY_FAILURE.OFFLINE })
      }
      signal?.throwIfAborted()
      const cookie = await this.cookie(attempt > 0)
      const payload = JSON.stringify({
        type: 'client-request',
        rpcId: `fleet-${randomUUID()}`,
        method: endpoint,
        payload: { args },
      })
      const response = await httpOverSsh(this.connection, serving.port, {
        path: `/api/${endpoint}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          cookie,
        },
        body: payload,
      })
      if (response.status === 401) {
        lastError = Object.assign(new Error(`the remote rejected the call to ${endpoint} (HTTP 401)`), {
          code: GATEWAY_FAILURE.AUTH,
        })
        this.cookieValue = undefined
        continue
      }
      if (response.status !== 200) {
        throw Object.assign(
          new Error(`the remote answered HTTP ${String(response.status)} for ${endpoint}`),
          { code: GATEWAY_FAILURE.CARRIER },
        )
      }
      // A result carrying bytes comes back as `multipart/form-data`, not JSON:
      // `workspaceFiles/readBytes` is the common case, and a node's image or PDF
      // preview would silently break if this only JSON-parsed.
      let result
      try {
        result = decodeGatewayAnswer(response.body, response.headers['content-type'])
      } catch (error) {
        throw Object.assign(
          new Error(`the remote sent an unreadable answer for ${endpoint}: ${error.message}`),
          { code: GATEWAY_FAILURE.CARRIER, cause: error },
        )
      }
      if (result === undefined || typeof result !== 'object') {
        throw Object.assign(new Error(`the remote sent no result for ${endpoint}`), {
          code: GATEWAY_FAILURE.CARRIER,
        })
      }
      return result
    }
    throw lastError ?? Object.assign(new Error(`the call to ${endpoint} failed`), { code: GATEWAY_FAILURE.CARRIER })
  }

  /**
   * The live stream carrier, opening it on first use.
   * @returns {Promise<import('./ws.js').WebSocketClient>}
   */
  async carrierClient() {
    if (this.carrier !== undefined && !this.carrier.closed) return this.carrier
    if (this.carrierPending !== undefined) return this.carrierPending
    this.carrierPending = this.#openCarrier()
    try {
      return await this.carrierPending
    } finally {
      this.carrierPending = undefined
    }
  }

  async #openCarrier() {
    const serving = this.serving()
    if (serving === undefined) {
      throw Object.assign(new Error('this node is not serving yet'), { code: GATEWAY_FAILURE.OFFLINE })
    }
    const cookie = await this.cookie()
    const channel = await openChannel(this.connection, serving.port)
    const client = await upgradeWebSocket(channel.stream, {
      host: `127.0.0.1:${String(serving.port)}`,
      path: '/api/remote.mux',
      origin: `http://127.0.0.1:${String(serving.port)}`,
      cookie,
    }, {
      onText: text => this.#onCarrierText(text),
      onClose: () => {
        this.carrier = undefined
        for (const stream of [...this.streams.values()]) {
          try { stream.close() } catch { /* closing anyway */ }
        }
        this.streams.clear()
      },
    })
    this.carrier = client
    return client
  }

  /** Fan one carrier frame out to the logical stream it belongs to. */
  #onCarrierText(text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (frame.type === 'item') {
      stream?.handlers.onFrame(frame.value)
      return
    }
    if (frame.type === 'end') {
      this.streams.delete(frame.streamId)
      stream?.finish()
      return
    }
    if (frame.type === 'error') {
      this.streams.delete(frame.streamId)
      stream?.finish()
      stream?.handlers.onEnd(frame.error)
    }
  }

  /**
   * Open one logical stream on the shared carrier.
   *
   * The returned handle can also carry a *node-bound uplink*: a browser-facing
   * method that is itself a stream (`terminal/attach`, for instance) takes its
   * uplink items from this Host's own mux and has to hand them to the node instead
   * of consuming them locally. `send`/`endUplink` are that direction.
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @param {{ onFrame: (value: unknown) => void, onEnd: (failure?: unknown) => void }} handlers
   * @returns {Promise<{ close: () => void, send: (value: unknown) => boolean, endUplink: () => void }>}
   */
  async openStream(endpoint, args, handlers) {
    const carrier = await this.carrierClient()
    const stream = new LogicalStream(endpoint, handlers, carrier)
    this.streams.set(stream.id, stream)
    const sent = carrier.send(JSON.stringify({ type: 'open', streamId: stream.id, endpoint, payload: { args } }))
    if (!sent) {
      this.streams.delete(stream.id)
      throw Object.assign(new Error('the stream carrier is not writable'), { code: GATEWAY_FAILURE.CARRIER })
    }
    return {
      close: () => {
        if (!this.streams.has(stream.id)) return
        this.streams.delete(stream.id)
        stream.close()
      },
      send: value => stream.send(value),
      endUplink: () => stream.endUplink(),
    }
  }
}
