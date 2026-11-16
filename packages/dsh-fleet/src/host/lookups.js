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
 * @module @local/dsh-fleet/host/lookups
 */
import { decodeRemoteId } from './routing.js'

/** The lookup key `dsh-api-workspace-files` declares for its first parameter. */
const WORKSPACE_FILE_SCOPE = 'workspaceFileScope'

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
