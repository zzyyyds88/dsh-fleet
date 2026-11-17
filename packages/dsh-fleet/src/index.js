/**
 * `@local/dsh-fleet` Host half: remote Linux machines as first-class workspaces.
 *
 * The architectural choice this plugin makes is the one that decides whether
 * remote tools work: **the brain stays on the node**. Each machine runs its own
 * DeepSeek Harness host, so `bash`, `grep`, `git`, `read_image`, PTYs, MCP servers
 * and skills all execute there, against that machine's filesystem and binaries,
 * with nothing mirrored, translated or proxied.
 *
 * The local Host is the *conductor*: it keeps one warm SSH connection per node,
 * routes the four Remote namespaces that name a Session or a Workspace
 * (`session`, `workspace`, `workspaceFiles`, `terminal`) to the node that owns the
 * identity, and merges every node's workspaces into the one `workspace/follow`
 * stream the local sidebar already renders.
 *
 * Concretely that means a remote Session appears in the local sidebar as a real
 * Session with a real history, so `ds-harness-remote` forwards it to a phone
 * without knowing this plugin exists — its `session/list`, `session/follow` and
 * `session/prompt` endpoints simply answer with more rows and route accordingly.
 *
 * Routing never touches a class, a Loader row or an upstream import: each
 * replacement is an own property on the live Service instance, which the Gateway
 * resolves at dispatch time and ignores during discovery. Undecorated endpoints
 * keep their exact upstream behaviour.
 *
 * @module @local/dsh-fleet
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiError, describeFailure, readJsonBody, sendJson } from './core/http-error.js'
import { Fleet } from './host/fleet.js'
import { RemoteControl } from './host/remote-control.js'
import { RemoteEvents } from './host/remote-events.js'
import { RemoteWaterfalls } from './host/remote-waterfall.js'
import { RemoteWorkspaces } from './host/remote-workspaces.js'
import { Router } from './host/router.js'
import { overrideAgentLookup, overrideWorkspaceFileScope } from './host/lookups.js'
import {
  decorateJobController,
  decorateSessionController,
  decorateTerminalController,
  decorateWorkspaceController,
  decorateWorkspaceFiles,
} from './host/decorators.js'
// `router.toLocalWorkspace` handles workspace identities; this import keeps the
// management route honest about which identities it answers for.
import { decodeRemoteId } from './host/routing.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-fleet'

/** Every service this plugin reads; all ship with a standard Host. */
export const inject = ['webServer', 'credentials']

/** Where the settings surface talks to this plugin. */
const API_MOUNT = '/fleet/api'

/**
 * Read the DSH version this profile runs, so every node is installed to match.
 * A version skew between Host and node would desynchronise the Session format.
 */
function localDshVersion() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir.length > 0) {
    try {
      const manifest = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'))
      if (typeof manifest.version === 'string') return manifest.version
    } catch {
      // Fall through to the version the Desktop shell publishes.
    }
  }
  return process.env.DSH_CLIENT_VERSION ?? '0.0.0'
}

/**
 * Register the fleet: durable node records, live connections, the routing
 * decorators, and the management API a settings surface reads.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, autoConnect?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const log = message => ctx.logger?.info?.(message)
  const version = localDshVersion()
  const fleet = new Fleet({
    credentials: ctx.credentials,
    version,
    configEditor: () => configEditor,
    log,
  })
  const workspaces = new RemoteWorkspaces(fleet)
  const router = new Router({ fleet, log })
  const control = new RemoteControl(fleet, router, log)
  /** @type {Array<() => void>} */
  const disposers = []

  /** One request handler over the management API, with uniform failures. */
  const guard = handler => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const failure = describeFailure(error)
      log(`fleet api: ${failure.error}`)
      sendJson(res, failure.status, { ok: false, code: failure.code, error: failure.error })
    }
  }

  // ---- Management API -------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: API_MOUNT,
    handler: guard(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const segments = url.pathname.slice(API_MOUNT.length).split('/').filter(Boolean)
      const [head, id, action] = segments

      if (head === 'nodes' && id === undefined) {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            version,
            local: { version, role: 'conductor' },
            nodes: fleet.list().map(runtime => runtime.describe()),
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const node = body.node ?? body
          const runtime = await fleet.put(node)
          sendJson(res, 200, { ok: true, node: runtime.describe() })
          return
        }
        throw apiError('method-not-allowed', 'use GET or POST on the node collection', 405)
      }

      if (head === 'nodes' && id !== undefined && action === undefined) {
        if (req.method === 'DELETE') {
          const removed = await fleet.remove(id)
          sendJson(res, removed ? 200 : 404, { ok: true })
          return
        }
        const runtime = fleet.get(id)
        if (runtime === undefined) throw apiError('node-not-found', `no node ${id}`, 404)
        if (req.method === 'PATCH' || req.method === 'POST') {
          const body = await readJsonBody(req)
          const node = body.node ?? body
          const updated = await fleet.put({ ...runtime.record, ...node })
          sendJson(res, 200, { ok: true, node: updated.describe() })
          return
        }
        sendJson(res, 200, { ok: true, node: runtime.describe() })
        return
      }

      if (head === 'nodes' && id !== undefined) {
        const runtime = fleet.get(id)
        if (runtime === undefined) throw apiError('node-not-found', `no node ${id}`, 404)
        if (req.method !== 'POST') throw apiError('method-not-allowed', 'node actions use POST', 405)
        if (action === 'connect') {
          // Answer at once; the settings surface polls while the node comes up.
          setImmediate(() => { void fleet.connect(runtime).catch(() => undefined) })
          sendJson(res, 202, { ok: true, node: runtime.describe() })
          return
        }
        if (action === 'disconnect') {
          sendJson(res, 200, { ok: true, node: await fleet.disconnect(runtime) })
          return
        }
        if (action === 'probe') {
          runtime.facts = await runtime.host.probe()
          sendJson(res, 200, { ok: true, node: runtime.describe() })
          return
        }
        if (action === 'reinstall') {
          runtime.phase = 'install'
          try {
            runtime.facts = await runtime.host.probe()
            await runtime.host.install(runtime.facts)
          } finally {
            runtime.phase = undefined
          }
          sendJson(res, 200, { ok: true, node: runtime.describe() })
          return
        }
        throw apiError('action-not-found', `unknown node action ${action}`, 404)
      }

      if (head === 'workspaces' && id === undefined) {
        if (req.method === 'GET') {
          await workspaces.sync()
          sendJson(res, 200, { ok: true, baseline: workspaces.baseline() })
          return
        }
        if (req.method === 'POST') {
          // Register a directory on a node as a workspace.
          //
          // The local directory picker browses THIS machine, so it can never select
          // `/root/project` on a node. This endpoint is how a remote workspace gets
          // added: the caller names the node and a path that exists over there, and
          // the node registers it in its own registry.
          const body = await readJsonBody(req)
          const nodeId = typeof body.nodeId === 'string' ? body.nodeId : undefined
          const path = typeof body.path === 'string' ? body.path.trim() : ''
          if (nodeId === undefined) throw apiError('node-required', 'name the node this directory lives on', 400)
          if (!path.startsWith('/')) {
            throw apiError('path-invalid', 'a remote workspace path must be absolute, e.g. /root/project', 400)
          }
          const runtime = fleet.get(nodeId)
          if (runtime === undefined) throw apiError('node-not-found', `no node ${nodeId}`, 404)
          if (!runtime.routable) throw apiError('node-offline', `${runtime.record.name} is not connected`, 409)
          const value = await router.call(nodeId, 'workspace/create', { request: { path } })
          await workspaces.sync()
          sendJson(res, 200, { ok: true, workspace: router.toLocalWorkspace(value, nodeId) })
          return
        }
        throw apiError('method-not-allowed', 'use GET or POST on the workspace collection', 405)
      }

      if (head === 'workspaces' && id !== undefined && req.method === 'POST' && action === 'rename') {
        const decoded = decodeRemoteId(id)
        if (decoded === undefined) throw apiError('workspace-local', 'this is not a remote workspace', 400)
        const body = await readJsonBody(req)
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title.length === 0) throw apiError('title-required', 'a title is required', 400)
        const value = await router.call(decoded.nodeId, 'workspace/rename', {
          request: { workspaceId: decoded.remoteId, title },
        })
        await workspaces.sync()
        sendJson(res, 200, { ok: true, workspace: router.toLocalWorkspace(value, decoded.nodeId) })
        return
      }

      if (head === 'workspaces' && id !== undefined) {
        throw apiError('not-supported', 'remove a remote workspace from its own Harness', 400)
      }

      throw apiError('route-not-found', `no fleet route for ${req.method ?? 'GET'} ${url.pathname}`, 404)
    }),
  }))

  // ---- Routing decorators ---------------------------------------------------
  // Installed once the Host has composed the controllers they decorate. A missing
  // service (a --no-web composition) simply leaves routing absent rather than
  // failing the plugin.
  ctx.inject(['sessionController', 'workspaceController', 'workspaceFiles'], scope => {
    const session = scope.get('sessionController')
    const workspace = scope.get('workspaceController')
    const files = scope.get('workspaceFiles')
    if (session === undefined || workspace === undefined || files === undefined) return
    const undo = [
      decorateSessionController(session, router, workspaces, control),
      decorateWorkspaceController(workspace, router, workspaces),
      decorateWorkspaceFiles(files, router),
    ]
    // The job roster is how a remote Session's background work shows up in its
    // panel; without this a node's job list reads as empty, which is
    // indistinguishable from "this Session started nothing".
    const jobs = scope.get('jobController')
    if (jobs !== undefined) undo.push(decorateJobController(jobs, router))
    const terminal = scope.get('terminalController')
    if (terminal !== undefined) undo.push(decorateTerminalController(terminal, router))
    // A remote Session id is not a local Session, so the Gateway's own lookup
    // cannot resolve a file scope for it; teach that lookup about wrapped ids.
    const undoLookup = overrideWorkspaceFileScope(scope)
    // The same problem one level up: every `agent: Agent` parameter is resolved from
    // `agentId` before the method runs, so `terminal/create|attach|close|…` fails for
    // a remote Session before its decorator can route anything.
    const undoAgent = overrideAgentLookup(scope)
    log(`fleet: routing session, workspace, workspaceFiles${jobs === undefined ? '' : ', job'}${terminal === undefined ? '' : ', terminal'}`)
    scope.effect(() => () => {
      for (const restore of undo) {
        try { restore() } catch { /* the instance may already be disposed */ }
      }
      try { undoLookup?.() } catch { /* already gone */ }
      try { undoAgent?.() } catch { /* already gone */ }
    }, 'dsh-fleet: routing decorators')
  })

  // ---- Provisioning ---------------------------------------------------------
  // A node is a separate DSH installation, so it needs this Host's model rows and
  // API keys to be usable as a brain. `configEditor` only exists once the Host has
  // composed it; until then the accessor returns `undefined` and provisioning
  // degrades to "start the node as-is" instead of failing the connection.
  /** @type {object | undefined} */
  let configEditor
  ctx.inject(['configEditor'], scope => {
    configEditor = scope.get('configEditor')
  })

  // ---- Keeping connected nodes in step --------------------------------------
  // The local Host is the only source of truth for "which model, whose key", so a
  // change here has to reach a running node without asking the user to reconnect.
  // Two upstream signals cover every way that configuration can change:
  //
  //   `app-boot/config-reload`        — emitted after `configEditor` rewrites config
  //   `credentials/reference-updated` — emitted when a key value is written
  //
  // Both are plain Cordis events, so subscribing needs no upstream import. The sync
  // itself writes the node's *profile* patch, which the node host hot-reloads
  // (see `docs/adr-0001`) — no restart, no dropped session.
  //
  // `app-boot/config-reload` fires while the Loader is still settling and
  // `credentials/reference-updated` can fire several times for one edit, so the sync
  // is coalesced onto one timer rather than run per event. Reading configuration
  // synchronously inside the event would see a half-applied composition.
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pendingSync
  const scheduleSync = reason => {
    clearTimeout(pendingSync)
    pendingSync = setTimeout(() => {
      void fleet.syncConfig(reason).catch(error => log(`fleet: config sync failed: ${error.message}`))
    }, 250)
    pendingSync.unref?.()
  }
  for (const event of ['app-boot/config-reload', 'credentials/reference-updated']) {
    ctx.on(event, () => scheduleSync(event))
  }

  // ---- Node events -----------------------------------------------------------
  // `session/list` and `workspace/follow` are snapshots. The sidebar also *listens*:
  // upstream's client half keeps its list live from five `api-session/*` events, and
  // a remote Session emits none locally. This relays a node's forwarded-event stream
  // into this Host's own bus with the identities wrapped, so a remote row updates
  // through exactly the path a local one uses.
  //
  // The same stream carries the two scoped waterfalls — `approval/request` and
  // `user-questions/request`. Those need the Gateway the Host composed, so the relay
  // is created inside `inject` and this holder starts out empty; until it exists the
  // older behaviour (answer with the node's default) still applies.
  /** @type {import('./host/remote-waterfall.js').RemoteWaterfalls | undefined} */
  let waterfalls
  const remoteEvents = new RemoteEvents(fleet, router, {
    emit: (event, args) => ctx.emit(event, ...args),
    log,
  }, {
    forNode: runtime => waterfalls?.forNode(runtime),
  })
  ctx.inject(['typertGateway'], scope => {
    const gateway = scope.get('typertGateway')
    if (gateway === undefined) return
    waterfalls = new RemoteWaterfalls(fleet, router, gateway, { log })
    waterfalls.sync()
    remoteEvents.adopt(waterfalls)
    scope.effect(() => () => {
      waterfalls?.dispose()
      waterfalls = undefined
    }, 'dsh-fleet: relayed waterfalls')
  })

  // ---- Boot and teardown ----------------------------------------------------
  disposers.push(fleet.subscribe(() => {
    remoteEvents.sync()
    control.sync()
  }))
  disposers.push(ctx.effect(() => () => {
    remoteEvents.dispose()
    control.dispose()
  }, 'dsh-fleet: node events and control'))

  disposers.push(ctx.effect(() => {
    if (config.autoConnect === false) return () => undefined
    const timer = fleet.autoConnect(2_000)
    return () => clearTimeout(timer)
  }, 'dsh-fleet: automatic connection'))

  disposers.push(ctx.effect(() => () => {
    clearTimeout(pendingSync)
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* already disposed */ }
    }
    router.dispose()
    workspaces.dispose()
    fleet.dispose()  }, 'dsh-fleet: routes and connections'))
}
