/**
 * The four routing decorators plus the merged control stream: `session`,
 * `workspace`, `workspaceFiles`, `terminal`.
 *
 * Each factory takes the live upstream Service and the router, and returns an
 * undo function. Nothing here replaces a Loader row, imports from inside
 * app.asar, or changes a class: every replacement is an own property on the
 * instance, which the Gateway resolves at dispatch and never at discovery.
 *
 * A local call (an identity with no `fleet_` prefix) is forwarded verbatim to the
 * upstream method. A remote call is translated into the node's own identities,
 * dispatched, and translated back.
 *
 * @module @local/dsh-fleet/host/decorators
 */
import { mergeControlStream } from './remote-control.js'
import { AsyncQueue, decodeRemoteId, decorateMethods, remoteIterable } from './routing.js'

/** Read a nested request field without trusting its shape. */
function requestOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const request = Reflect.get(value, 'request')
  return request !== null && typeof request === 'object' ? request : undefined
}

/** Session identity carried by a request object. */
function sessionIdIn(request) {
  if (request === undefined) return undefined
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
 * Install the `session` namespace router.
 *
 * Routed: `list`, `search`, `create`, `rename`, `fork`, `prompt`, `cancel`,
 * `updateQueue`, `attachment`, `page`, `events`, `state`, `wait`, `projections`,
 * `selectModel`, `modelCatalog`, the four per-Session streams, and `control`
 * (merged rather than forwarded — it is Host-wide, not per-Session). Everything
 * else (`openWorkspacePath`, `skills`, …) stays local.
 *
 * @param {object} service - the live upstream `SessionController`.
 * @param {import('./router.js').Router} router
 * @param {import('./remote-workspaces.js').RemoteWorkspaces} workspaces
 * @param {import('./remote-control.js').RemoteControl} control
 * @returns {() => void}
 */
export function decorateSessionController(service, router, workspaces, control) {
  /** The node a workspace belongs to, if the workspace is remote. */
  const nodeOfWorkspace = workspaceId => decodeRemoteId(workspaceId)

  /**
   * Route one Session stream endpoint.
   *
   * Two shapes differ from the unary endpoints and both matter:
   *   - the Gateway passes the request *positionally* (`(request, signal)`), not as
   *     `{ request }`, because a stream method's first parameter is the request;
   *   - the node's own parameter is named `request`, so the forwarded wire payload
   *     has to wrap it again as `{ args: { request } }`.
   */
  const streaming = (endpoint, local) => (request, signal) => {
    const decoded = decodeRemoteId(sessionIdIn(request))
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

  return decorateMethods(service, {
    // --- list: merge local rows with every connected node's -----------------
    list: local => async function list(_request, signal) {
      const own = await local(_request, signal)
      const items = Array.isArray(Reflect.get(own ?? {}, 'items')) ? [...Reflect.get(own, 'items')] : []
      await workspaces.sync()
      for (const runtime of router.nodes()) {
        const nodeId = runtime.record.id
        try {
          const remote = await router.call(nodeId, 'session/list', { _request: {} }, signal)
          const remoteItems = Reflect.get(remote ?? {}, 'items')
          if (!Array.isArray(remoteItems)) continue
          for (const item of remoteItems) {
            const wrapped = router.toLocal(item, nodeId)
            const id = Reflect.get(wrapped ?? {}, 'sessionId')
            if (typeof id === 'string') items.push(wrapped)
          }
        } catch {
          // An offline or refusing node contributes no rows rather than failing
          // the whole sidebar.
        }
      }
      items.sort((left, right) => Number(Reflect.get(right, 'updatedAt') ?? 0) - Number(Reflect.get(left, 'updatedAt') ?? 0))
      return { items }
    },

    // --- create: a remote workspace creates on its node ---------------------
    create: local => async function create(request, signal) {
      const workspaceId = request === null || typeof request !== 'object'
        ? undefined
        : Reflect.get(request, 'workspaceId')
      const target = nodeOfWorkspace(workspaceId)
      if (target === undefined) return await local(request, signal)
      const payload = router.toRemote({ request: request ?? {} }, target.nodeId)
      const value = await router.call(target.nodeId, 'session/create', payload, signal)
      return router.toLocal(value, target.nodeId)
    },

    // --- the ordinary per-Session unary endpoints ---------------------------
    search: local => async function search(request, signal) {
      const own = await local(request, signal)
      const items = Array.isArray(Reflect.get(own ?? {}, 'items')) ? [...Reflect.get(own, 'items')] : []
      const query = request === null || typeof request !== 'object' ? undefined : Reflect.get(request, 'query')
      if (typeof query === 'string' && query.trim().length > 0) {
        for (const runtime of router.nodes()) {
          const nodeId = runtime.record.id
          try {
            const remote = await router.call(nodeId, 'session/search', { request: { query } }, signal)
            const remoteItems = Reflect.get(remote ?? {}, 'items')
            if (Array.isArray(remoteItems)) items.push(...remoteItems.map(item => router.toLocal(item, nodeId)))
          } catch { /* a node that cannot search contributes nothing */ }
        }
      }
      return { ...own, items, hasMore: Reflect.get(own ?? {}, 'hasMore') === true }
    },

    rename: local => router.sessionEndpoint('rename', local),
    fork: local => router.sessionEndpoint('fork', local),
    prompt: local => router.sessionEndpoint('prompt', local),
    cancel: local => router.sessionEndpoint('cancel', local),
    updateQueue: local => router.sessionEndpoint('updateQueue', local),
    attachment: local => router.sessionEndpoint('attachment', local),
    page: local => router.sessionEndpoint('page', local),
    events: local => router.sessionEndpoint('events', local),
    state: local => router.sessionEndpoint('state', local),
    wait: local => router.sessionEndpoint('wait', local),
    projections: local => router.sessionEndpoint('projections', local),
    selectModel: local => router.sessionEndpoint('selectModel', local),

    // `modelCatalog` and `initializeDefaultModel` take no arguments and describe
    // this Host's own provider roster, so they stay local by design.

    // --- the four per-Session streams --------------------------------------
    // A stream endpoint's first positional argument IS the request object; it is
    // not wrapped in `{ request }` the way a unary wire payload is. Forwarding
    // therefore re-wraps it, because the node's own parameter is called `request`.
    follow: local => streaming('follow', local),
    observeEvent: local => streaming('observeEvent', local),
    observeProjections: local => streaming('observeProjections', local),
    observeState: local => streaming('observeState', local),

    // --- the Host-wide control stream ---------------------------------------
    // Every attached client keeps a Session list from this stream, so a remote
    // Session's title, model selection and pending-input flags only move if its
    // frames reach the client. There is nothing to route here: the frame carries
    // the Session id, and the merged stream is per consumer, so `control` becomes
    // one merged stream instead of one forwarded call.
    //
    // The inner function must not be called `control`: it would shadow the
    // `RemoteControl` argument in its own body.
    control: local => function controlStream(signal) {
      return mergeControlStream(local(signal), control, signal)
    },
  })
}

/**
 * Install the `workspace` namespace router.
 *
 * `follow` becomes one merged stream: the local baseline plus every node's
 * workspaces, then live increments from both. Every mutation is routed to the
 * node that owns the workspace, and a mutation naming a remote Session (pin,
 * archive, ordering) goes to that Session's node.
 *
 * @param {object} service - the live upstream `WorkspaceController`.
 * @param {import('./router.js').Router} router
 * @param {import('./remote-workspaces.js').RemoteWorkspaces} workspaces
 * @returns {() => void}
 */
export function decorateWorkspaceController(service, router, workspaces) {
  /** The node that owns a workspace or session identity. */
  const ownerOf = request => {
    if (request === null || typeof request !== 'object') return undefined
    return decodeRemoteId(Reflect.get(request, 'workspaceId'))
      ?? decodeRemoteId(Reflect.get(request, 'sessionId'))
      ?? decodeRemoteId(Reflect.get(request, 'beforeSessionId'))
  }

  /** Route a mutation whose owner is a node. */
  const mutation = (endpoint, local) => async function routed(request, signal) {
    const owner = ownerOf(request)
    if (owner === undefined) return await local(request, signal)
    const payload = router.toRemote({ request: request ?? {} }, owner.nodeId)
    return router.toLocalWorkspace(
      await router.call(owner.nodeId, `workspace/${endpoint}`, payload, signal),
      owner.nodeId,
    )
  }

  return decorateMethods(service, {
    follow: local => function follow(signal) {
      const own = local(signal)
      return mergeWorkspaceStream(own, workspaces, signal)
    },

    create: local => async function create(request, signal) {
      const path = request === null || typeof request !== 'object' ? undefined : Reflect.get(request, 'path')
      // A remote path (an absolute POSIX path under a connected node) creates the
      // workspace on that node: it is the only Host that can see that directory.
      if (typeof path === 'string' && path.startsWith('/')) {
        for (const runtime of router.nodes()) {
          const nodeId = runtime.record.id
          try {
            const value = await router.call(nodeId, 'workspace/create', { request: { path } }, signal)
            if (Reflect.get(value ?? {}, 'workspace') !== undefined) {
              return router.toLocalWorkspace(value, nodeId)
            }
          } catch { /* this node cannot see that path; try the next */ }
        }
      }
      return await local(request, signal)
    },

    rename: local => mutation('rename', local),
    delete: local => mutation('delete', local),
    insertBefore: local => mutation('insertBefore', local),
    insertSessionBefore: local => mutation('insertSessionBefore', local),
    archiveSession: local => mutation('archiveSession', local),
    unarchiveSession: local => mutation('unarchiveSession', local),
    pinSession: local => mutation('pinSession', local),
    unpinSession: local => mutation('unpinSession', local),
  })
}

/**
 * Combine one local `workspace/follow` generation with the merged remote picture.
 *
 * Both sources are pumped into one queue, so a remote increment is delivered the
 * moment it arrives instead of waiting behind the local stream's idle read. The
 * local generation's opening baseline is the one that gets expanded with remote
 * rows; if the local stream ends first (the Host is shutting down) the merged
 * stream ends with it.
 *
 * @param {AsyncIterable<unknown>} local
 * @param {import('./remote-workspaces.js').RemoteWorkspaces} workspaces
 * @param {AbortSignal | undefined} signal
 * @returns {AsyncIterable<unknown>}
 */
function mergeWorkspaceStream(local, workspaces, signal) {
  return {
    [Symbol.asyncIterator]() {
      const queue = new AsyncQueue()
      let opened = false
      let stopped = false
      const first = () => {
        const merged = workspaces.mergeBaseline(undefined)
        opened = true
        return { type: 'baseline', value: merged }
      }
      const unsubscribe = workspaces.subscribe(frame => {
        if (stopped) return
        if (!opened) queue.push(first())
        queue.push(frame)
      })
      const onAbort = () => { stopped = true }
      signal?.addEventListener('abort', onAbort, { once: true })

      const pump = async () => {
        try {
          await workspaces.sync()
          for await (const frame of local) {
            if (stopped) return
            if (!opened && Reflect.get(frame ?? {}, 'type') === 'baseline') {
              opened = true
              queue.push({ type: 'baseline', value: workspaces.mergeBaseline(Reflect.get(frame, 'value')) })
            } else {
              if (!opened) queue.push(first())
              queue.push(frame)
            }
          }
        } catch (error) {
          queue.fail(error)
          return
        } finally {
          unsubscribe()
          signal?.removeEventListener('abort', onAbort)
        }
        // The local feed ended: this Host is going away, so the merged stream
        // ends too rather than idling on a registry that no longer changes.
        if (!opened) queue.push(first())
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

/**
 * Install the `workspaceFiles` namespace router.
 *
 * Every endpoint takes a `workspaceFileScope` lookup object that the Host derives
 * from the Session id, so the Session identity is the only thing that has to be
 * translated: a remote Session's files live on that node and only that node can
 * read them.
 *
 * One wire detail matters here: several of these endpoints declare a parameter the
 * *caller* may omit (e.g. `read`'s `range`, `readBytes`'s `options`), and the strict
 * descriptor rejects a missing field. The routed payload therefore carries the
 * field only when the caller supplied it, so a three-argument `read` stays a
 * three-argument `read`.
 *
 * @param {object} service - the live upstream `WorkspaceFiles`.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateWorkspaceFiles(service, router) {
  /**
   * Rewrite the lookup result the same way the Gateway would, then call the node.
   * The Gateway substitutes `workspaceFileScope` from `workspaceFileScopeId`, so a
   * decorated method receives the resolved object — this router must therefore
   * accept the same positional shape.
   */
  const fileMethod = (endpoint, indexed) => local => async function routed(...args) {
    const signal = args.at(-1)
    const scope = args[0]
    const sessionId = scope === null || typeof scope !== 'object'
      ? undefined
      : Reflect.get(scope, 'sessionId')
    const decoded = decodeRemoteId(sessionId)
    if (decoded === undefined) return await local(...args)
    const rest = args.slice(1, -1).map(value => router.toRemote(value, decoded.nodeId))
    /** Wire fields, with positionally-absent arguments left out entirely. */
    const fields = {}
    if (indexed) {
      rest.forEach((value, index) => {
        const name = indexed[index]
        if (name === undefined || value === undefined) return
        fields[name] = value
      })
    }
    const payload = { workspaceFileScopeId: decoded.remoteId, ...fields }
    const value = await router.call(decoded.nodeId, `workspaceFiles/${endpoint}`, payload, signal)
    return router.toLocal(value, decoded.nodeId)
  }

  return decorateMethods(service, {
    read: fileMethod('read', ['path', 'range']),
    readBytes: fileMethod('readBytes', ['path', 'options']),
    stat: fileMethod('stat', ['path']),
    list: fileMethod('list', ['path']),
    search: fileMethod('search', ['request']),
    changes: local => function changes(scope, path, signal) {
      const sessionId = scope === null || typeof scope !== 'object' ? undefined : Reflect.get(scope, 'sessionId')
      const decoded = decodeRemoteId(sessionId)
      if (decoded === undefined) return local(scope, path, signal)
      const payload = router.toRemote({ workspaceFileScopeId: decoded.remoteId, path }, decoded.nodeId)
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'workspaceFiles/changes',
        payload,
        signal,
        value => router.toLocal(value, decoded.nodeId),
      )
    },
  })
}

/**
 * Install the `terminal` namespace router.
 *
 * A remote Session's terminals are PTYs on that node. `list` and `watch` take a
 * Session id, so both are forwarded; every other terminal endpoint takes an
 * `Agent` object that the Gateway resolves from `agentId` on *this* Host, which a
 * remote Session has no local Agent for. Those endpoints therefore stay local:
 * the sidebar simply reports no controllable terminals for a remote Session,
 * rather than pretending to own one it cannot drive.
 *
 * @param {object} service - the live upstream `TerminalController`.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateTerminalController(service, router) {
  return decorateMethods(service, {
    list: local => async function list(sessionId, signal) {
      const decoded = decodeRemoteId(sessionId)
      if (decoded === undefined) return await local(sessionId, signal)
      return await router.call(decoded.nodeId, 'terminal/list', { sessionId: decoded.remoteId }, signal)
    },
    watch: local => function watch(sessionId, signal) {
      const decoded = decodeRemoteId(sessionId)
      if (decoded === undefined) return local(sessionId, signal)
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'terminal/watch',
        { sessionId: decoded.remoteId },
        signal,
      )
    },
  })
}
