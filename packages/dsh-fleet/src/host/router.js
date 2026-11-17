/**
 * Route `session`, `workspace`, `workspaceFiles` and `terminal` Remote endpoints
 * between this Host and every configured node.
 *
 * The mechanism is one own property per routing endpoint on the live Service
 * instance. The Gateway discovers endpoints from the class prototype descriptor,
 * so its declared surface does not change, while `Reflect.get(view, name)` at
 * dispatch resolves the instance property first. Every endpoint this module does
 * not replace keeps working untouched — including the upstream class's
 * `static inject`, config schema, and every non-routed method.
 *
 * A remote identity never leaks into local state. It crosses the boundary as
 * `fleet_<nodeId>_<remoteId>`, so one string answers all three questions a router
 * asks: is this remote, which node, and what is it called there.
 *
 * @module @local/dsh-fleet/host/router
 */
import {
  AsyncQueue,
  decodeRemoteId,
  encodeRemoteId,
  isRemoteId,
  remoteIterable,
  remapIds,
} from './routing.js'

/** Endpoint families whose arguments name a Session. */
const SESSION_REQUEST_KEYS = Object.freeze(['request', 'sessionId', 'address'])

/**
 * One Session identity as DSH mints it: `session-` followed by a uuid.
 *
 * The exact shape matters. A looser `startsWith('session-')` test also matches
 * Session *event types* like `session-log-deepseek/delivery-accepted`, and
 * rewriting those would silently corrupt every event the client renders.
 */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * A Session identity with no `session-` marker.
 *
 * A subagent's own Session is stored as a bare uuid, so a client that lists one gets
 * `sessionId: "93f9…"` and builds a `{kind:'subagent', parentSessionId, childSessionId}`
 * address from it. Left unwrapped, that child id names nothing on this Host, the route
 * falls through to the local implementation, and opening the child's history answers
 * `subagent/not-found`. A bare uuid is only ever a subagent Session here, and only a
 * Session field can hold one, so the field name is what makes wrapping safe.
 */
const BARE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Fields whose value is a Session identity even when it carries no `session-` marker. */
const SESSION_FIELDS = Object.freeze(new Set(['sessionId', 'childSessionId', 'parentSessionId']))

/**
 * Pull the Session identity out of one request object.
 * @param {Record<string, unknown> | undefined} request
 * @returns {string | undefined}
 */
function sessionIdOf(request) {
  if (request === undefined || request === null || typeof request !== 'object') return undefined
  const direct = Reflect.get(request, 'sessionId')
  if (typeof direct === 'string') return direct
  const address = Reflect.get(request, 'address')
  if (address !== null && typeof address === 'object') {
    const kind = Reflect.get(address, 'kind')
    const id = kind === 'session'
      ? Reflect.get(address, 'sessionId')
      : Reflect.get(address, 'childSessionId')
    if (typeof id === 'string') return id
  }
  return undefined
}

/**
 * Pull the Workspace identity out of one request object.
 * @param {Record<string, unknown> | undefined} request
 * @returns {string | undefined}
 */
function workspaceIdOf(request) {
  if (request === undefined || request === null || typeof request !== 'object') return undefined
  const direct = Reflect.get(request, 'workspaceId')
  return typeof direct === 'string' ? direct : undefined
}

/** A failure shaped like the Gateway's own Remote failure, so the client sees one protocol. */
class RoutedFailure extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.details = details
    this.isDSHRemoteError = true
  }
}

/** Translate one gateway failure into a Remote failure. */
function toFailure(error, endpoint) {
  if (error instanceof RoutedFailure) return error
  const code = typeof error?.code === 'string' ? error.code : 'fleet/unavailable'
  const message = error instanceof Error ? error.message : String(error)
  return new RoutedFailure(code, message, { endpoint })
}

/**
 * Everything the routing layer needs from the running Host.
 *
 * Kept explicit rather than reached through `ctx` so a test can drive a router
 * with a fake fleet and a fake gateway.
 */
export class Router {
  /**
   * @param {object} options
   * @param {import('./fleet.js').Fleet} options.fleet
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.fleet = options.fleet
    this.log = options.log ?? (() => {})
    /** @type {Set<() => void>} */
    this.disposers = new Set()
  }

  /** A live node, or a failure naming the one that is missing. */
  node(nodeId) {
    const runtime = this.fleet.get(nodeId)
    if (runtime === undefined) throw new RoutedFailure('fleet/node-unknown', `no node ${nodeId}`, { nodeId })
    if (!runtime.routable) {
      throw new RoutedFailure('fleet/node-offline', `${runtime.record.name} is not connected`, { nodeId })
    }
    return runtime
  }

  /** Every connected node. */
  nodes() {
    return this.fleet.routable()
  }

  /**
   * Local id for a remote Session, recording the reverse direction.
   * @param {string} nodeId
   * @param {string} remoteId
   */
  encode(nodeId, remoteId) {
    return encodeRemoteId(nodeId, remoteId)
  }

  /**
   * Turn one local request into the request a node must receive: every remote
   * identity it carries becomes the node's own identity again.
   * @param {unknown} value
   * @param {string} nodeId
   */
  toRemote(value, nodeId) {
    const map = new Map()
    const walk = node => {
      if (typeof node === 'string') {
        const decoded = decodeRemoteId(node)
        if (decoded !== undefined && decoded.nodeId === nodeId) {
          map.set(node, decoded.remoteId)
          return decoded.remoteId
        }
        return node
      }
      if (node === null || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(walk)
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) return node
      const out = {}
      for (const key of Object.keys(node)) out[key] = walk(node[key])
      return out
    }
    return walk(value)
  }

  /**
   * Turn one node's answer into the local form: its own identities become the
   * wrapped ones.
   *
   * A marked `session-<uuid>` string is rewritten wherever it appears. A plain
   * `session-` prefix test would also catch event types such as
   * `session-log-deepseek/delivery-accepted` and corrupt them, so the match is the
   * full identity shape.
   *
   * A **subagent's own Session has no marker**: the node stores and lists it as a
   * bare uuid. Only the field name says it is an identity, so `sessionId`,
   * `childSessionId` and `parentSessionId` are wrapped by name. Without that a
   * listed child row reached the client as a bare uuid, the client built a
   * subagent address from it, nothing on this Host decoded it, and opening that
   * child's history fell through to the local Host and answered
   * `subagent/not-found`.
   *
   * @param {unknown} value
   * @param {string} nodeId
   */
  toLocal(value, nodeId) {
    const map = new Map()
    const wrapString = node => {
      if (isRemoteId(node)) return node
      if (!SESSION_ID_PATTERN.test(node) && !BARE_SESSION_ID_PATTERN.test(node)) return node
      const encoded = encodeRemoteId(nodeId, node)
      map.set(node, encoded)
      return encoded
    }
    const wrap = (node, key) => {
      if (typeof node === 'string') {
        if (!SESSION_FIELDS.has(key) && !SESSION_ID_PATTERN.test(node)) return node
        return wrapString(node)
      }
      if (node === null || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(entry => wrap(entry, key))
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) return node
      const out = {}
      for (const field of Object.keys(node)) out[field] = wrap(node[field], field)
      return out
    }
    const walked = wrap(value, undefined)
    return map.size === 0 ? walked : remapIds(walked, map)
  }

  /**
   * Turn one node's Workspace answer into the local form.
   *
   * Session identities are recognisable by their `session-` prefix, but a
   * Workspace identity is a bare uuid with no marker, so it can only be wrapped
   * from its field name. This wraps `workspaceId`/`workspaceIds` (and the nested
   * `workspace` projection) on top of {@link Router#toLocal}.
   * @param {unknown} value
   * @param {string} nodeId
   */
  toLocalWorkspace(value, nodeId) {
    const encode = id => (isRemoteId(id) ? id : encodeRemoteId(nodeId, id))
    const walk = node => {
      if (node === null || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(walk)
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) return node
      const out = {}
      for (const key of Object.keys(node)) {
        const item = node[key]
        if ((key === 'workspaceId' || key === 'beforeWorkspaceId') && typeof item === 'string') {
          out[key] = encode(item)
        } else if (key === 'workspaceIds' && Array.isArray(item)) {
          out[key] = item.map(entry => (typeof entry === 'string' ? encode(entry) : walk(entry)))
        } else {
          out[key] = walk(item)
        }
      }
      return out
    }
    return this.toLocal(walk(value), nodeId)
  }

  /**
   * Call one unary endpoint on a node and unwrap its result.
   * @param {string} nodeId
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} [signal]
   */
  async call(nodeId, endpoint, args, signal) {
    const runtime = this.node(nodeId)
    const result = await runtime.gateway.call(endpoint, args, signal)
    if (result.ok !== true) {
      const failure = result.error ?? {}
      throw new RoutedFailure(
        typeof failure.code === 'string' ? failure.code : 'fleet/remote-failure',
        typeof failure.message === 'string' ? failure.message : `${endpoint} failed on the node`,
        typeof failure.details === 'object' && failure.details !== null ? failure.details : { endpoint },
      )
    }
    return result.value
  }

  /**
   * Route one Session endpoint: local calls reach the upstream implementation,
   * remote calls reach the node that owns the Session.
   *
   * @param {string} endpoint - the wire endpoint name, e.g. `prompt`.
   * @param {(request: Record<string, unknown>, signal?: AbortSignal) => unknown} local
   * @param {{ args?: 'request' | 'raw' }} [options] - how the Gateway passes arguments.
   * @returns {(request: Record<string, unknown>, signal?: AbortSignal) => unknown}
   */
  sessionEndpoint(endpoint, local, options = {}) {
    const router = this
    const wrapArgs = options.args ?? 'request'
    return async function routed(request, signal) {
      const id = wrapArgs === 'request' ? sessionIdOf(request) : sessionIdOf({ sessionId: request })
      const decoded = decodeRemoteId(id)
      if (decoded === undefined) return await local(request, signal)
      const payload = router.toRemote({ request: request ?? {} }, decoded.nodeId)
      return router.toLocal(
        await router.call(decoded.nodeId, `session/${endpoint}`, payload, signal),
        decoded.nodeId,
      )
    }
  }

  /**
   * Route one Workspace endpoint the same way.
   * @param {string} endpoint
   * @param {(request: Record<string, unknown>, signal?: AbortSignal) => unknown} local
   */
  workspaceEndpoint(endpoint, local) {
    const router = this
    return async function routed(request, signal) {
      const decoded = decodeRemoteId(workspaceIdOf(request))
      if (decoded === undefined) return await local(request, signal)
      const payload = router.toRemote({ request: request ?? {} }, decoded.nodeId)
      return router.toLocalWorkspace(
        await router.call(decoded.nodeId, `workspace/${endpoint}`, payload, signal),
        decoded.nodeId,
      )
    }
  }

  /**
   * Route one Session *stream* endpoint by proxying frames.
   * @param {string} endpoint
   * @param {(request: Record<string, unknown>, signal?: AbortSignal) => AsyncIterable<unknown>} local
   */
  sessionStream(endpoint, local) {
    const router = this
    return function routed(request, signal) {
      const decoded = decodeRemoteId(sessionIdOf(request))
      if (decoded === undefined) return local(request, signal)
      const payload = router.toRemote({ request: request ?? {} }, decoded.nodeId)
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        `session/${endpoint}`,
        payload,
        signal,
        value => router.toLocal(value, decoded.nodeId),
      )
    }
  }

  /** Release everything this router registered. */
  dispose() {
    for (const dispose of this.disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
    this.disposers.clear()
  }
}
