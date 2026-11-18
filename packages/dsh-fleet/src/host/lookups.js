/**
 * Teach the Typert registry to resolve workspace file scopes for remote Sessions.
 *
 * `workspaceFiles` does not receive a Session id as JSON: the Gateway *resolves*
 * it first through the `workspaceFileScope` lookup, whose provider reads the local
 * Session registry. A `fleet_…` identity is not a local Session, so that lookup
 * answers `gateway/lookup-not-found` and the decorator would never run.
 *
 * The registry allows exactly one resolver override per key (`configure`), and an
 * override wins over the registered provider. So this module captures the
 * provider's own `resolve` first, delegates every local identity to it verbatim,
 * and synthesises the scope object for a remote identity. Nothing about local
 * behaviour changes: an unknown local id still resolves to `undefined`, which the
 * Gateway reports exactly as it does today.
 *
 * @module @zzyyyds88/dsh-fleet/host/lookups
 */
import { decodeRemoteId } from './routing.js'

/** The lookup key `dsh-api-workspace-files` declares for its first parameter. */
const WORKSPACE_FILE_SCOPE = 'workspaceFileScope'

/**
 * The lookup key every `agent: Agent` parameter is resolved through.
 *
 * `@deepseek-ai/dsh-api-session-controller` claims it with `lookups.configure(...)`,
 * which refuses a second configuration of the same key. So this override cannot go
 * through the public `configure()`; it replaces the entry in the registry's own
 * resolver table, delegating every local identity to the resolver that was there.
 */
const AGENT = 'agent'

/**
 * Override the `workspaceFileScope` lookup so a remote Session resolves.
 *
 * The returned scope's `workspaceRoot` is deliberately `/`: a routed call never
 * uses it, because the node recomputes the scope from its own Session header. It
 * only has to be a string the schema accepts.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - a Context that can inject `typert`.
 * @param {string} endpointBase - unused; kept for symmetry with the other seams.
 * @returns {(() => void) | undefined} the undo, or `undefined` when unavailable.
 */
export function overrideWorkspaceFileScope(ctx, endpointBase) {
  void endpointBase
  let dispose
  let failed
  ctx.inject(['typert'], scope => {
    const lookups = scope.typert?.lookups
    if (lookups === undefined || typeof lookups.configure !== 'function') {
      failed = 'the typert lookup registry has no configure()'
      return
    }
    // Delegate to the provider the Host already registered. Reading it before
    // configuring is the only way to keep local resolution byte-identical: once
    // an override exists, `get()` returns the override, not the provider.
    const provider = lookups.get(WORKSPACE_FILE_SCOPE)
    if (provider === undefined || typeof provider.resolve !== 'function') {
      failed = `no ${WORKSPACE_FILE_SCOPE} provider is registered yet`
      return
    }
    const delegate = provider.resolve.bind(provider)
    try {
      dispose = lookups.configure(WORKSPACE_FILE_SCOPE, async sessionId => {
        const decoded = decodeRemoteId(sessionId)
        if (decoded === undefined) return await delegate(sessionId)
        // A remote Session's files are read on its own node, which derives the real
        // root from its own header; this placeholder only satisfies the wire type.
        return { sessionId, workspaceRoot: '/' }
      })
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error)
    }
  })
  return () => {
    try { dispose?.() } catch { /* the fiber may already be gone */ }
    void failed
  }
}

/**
 * Teach the `agent` lookup to resolve a wrapped Session identity.
 *
 * Six `terminal` endpoints and `userQuestions/answer` / `attachWait` take an
 * `Agent` object as their first parameter. The Gateway resolves that parameter from
 * the wire's `agentId` **before** the method body runs, so a decorator cannot help:
 * a `fleet_…` id is not a local Session, and the session controller's resolver
 * throws `session/not-found` first.
 *
 * The registry allows exactly one resolver per key, and the session controller has
 * already taken `agent` through the public `configure()`. This therefore writes the
 * resolver table directly — the one internal field this plugin touches — capturing
 * the current `resolve` first so every local identity is answered byte-identically.
 *
 * The placeholder it hands back is deliberately minimal: the Gateway only checks it
 * is not `undefined`, and every routed method reads nothing but `.id` (the wrapped
 * Session identity, which decodes back to the node's own). `.ctx` points at this
 * Host's context so a code path that reaches `agent.ctx.effect` does not explode
 * before the decorator decides to route.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - a Context that can inject `typert`.
 * @returns {(() => void) | undefined} the undo, or `undefined` when unavailable.
 */
export function overrideAgentLookup(ctx) {
  let dispose
  ctx.inject(['typert'], scope => {
    const store = scope.typert?.lookupStore
    const resolvers = store?.resolvers
    if (!(resolvers instanceof Map)) return
    // The provider registered by the core agent service: this is what gives the
    // placeholder its wire field names and resource kind.
    const provider = scope.typert.lookups?.get(AGENT)
    if (provider === undefined) return
    const previous = resolvers.get(AGENT)
    const delegate = previous?.provider?.resolve
    const owner = {}
    const entry = {
      owner,
      provider: {
        resolve: async sessionId => {
          const decoded = decodeRemoteId(sessionId)
          if (decoded === undefined) {
            if (delegate === undefined) return undefined
            return await delegate(sessionId)
          }
          return {
            id: sessionId,
            ctx: scope,
            // A remote Session has no local Session object. Anything that reaches for
            // it has taken the wrong branch; leaving it undefined turns that into a
            // visible TypeError instead of a silently wrong answer.
            session: undefined,
          }
        },
      },
    }
    resolvers.set(AGENT, entry)
    dispose = () => {
      if (resolvers.get(AGENT) !== entry) return
      if (previous === undefined) resolvers.delete(AGENT)
      else resolvers.set(AGENT, previous)
    }
    void provider
  })
  return () => {
    try { dispose?.() } catch { /* the fiber may already be gone */ }
  }
}
