/**
 * Which of this desktop's plugins a node should load — one switch per row.
 *
 * A node runs the *same* DSH release as the desktop, so it could load the same rows.
 * It should not: about sixty of them exist to drive a browser window that a node does
 * not have, and a few are outright wrong there (a native file dialog on a machine
 * nobody is sitting at). Until now that split was decided by
 * `packages/dsh-fleet-brain`, which hard-codes the subtraction from `dsh-web-app`.
 *
 * The switch here is the other half: a *per-row* decision, so a person can say "this
 * model adapter belongs on the node too" or "keep telemetry off it" without editing a
 * generated composition.
 *
 * Two rules this module keeps:
 *
 * - **Off means absent, not disabled.** The row is not written into the node's patch
 *   at all. A `disabled: true` entry for a row that is not in the composition is dead
 *   weight that hides the real signal.
 * - **The default comes from what the row is, not from a list of names.** Anything the
 *   browser surface owns defaults to off; everything else defaults to on. A new upstream
 *   UI row is therefore off on a node without anyone updating a list, and a new tool is
 *   on — which is the direction that fails safe for a node.
 *
 * @module @local/dsh-fleet/core/plugin-sync
 */

/**
 * Row-name shapes that exist to drive a window.
 *
 * Deliberately patterns rather than an exhaustive list: `@deepseek-ai/dsh-client-ui-*`
 * is an upstream naming convention, and the handful of non-conforming browser rows are
 * the ones already named in `packages/dsh-fleet-brain/scripts/sync-from-upstream.mjs`.
 */
const BROWSER_ONLY = Object.freeze([
  /^@deepseek-ai\/dsh-client-ui-/u,
  /^@deepseek-ai\/dsh-client-/u,
  /^@deepseek-ai\/dsh-web$/u,
  /^@deepseek-ai\/dsh-web-app/u,
  /^@deepseek-ai\/dsh-modules$/u,
  /^@deepseek-ai\/dsh-directory-picker$/u,
  /^@deepseek-ai\/dsh-open-in-app$/u,
  /^@deepseek-ai\/dsh-product-analytics$/u,
  /^@deepseek-ai\/dsh-desktop-/u,
  /^@deepseek-ai\/dsh-session-log-download$/u,
])

/**
 * Whether a row is browser-only, and therefore off on a node by default.
 * @param {unknown} name - the row's package name.
 * @returns {{ browserOnly: boolean, reason: string }}
 */
export function classifyRow(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { browserOnly: true, reason: 'a row with no package name cannot be loaded anywhere' }
  }
  for (const pattern of BROWSER_ONLY) {
    if (pattern.test(name)) {
      return { browserOnly: true, reason: 'drives a browser window, which a node does not have' }
    }
  }
  return { browserOnly: false, reason: 'host-plane: runs without a window' }
}

/**
 * The persisted shape: `{ "<rowId>": { sync: boolean } }`.
 *
 * A row with no entry uses its default, so an upgrade that adds rows does not have to
 * rewrite this file, and turning a switch back to its default is expressed by removing
 * the entry rather than by writing the same value twice.
 * @param {unknown} value
 */
export function parseSwitches(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [rowId, entry] of Object.entries(value)) {
    if (rowId.length === 0) continue
    const sync = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'sync') : entry
    if (typeof sync === 'boolean') out[rowId] = { sync }
  }
  return out
}

/**
 * Resolve every row's effective switch, and say where the answer came from.
 *
 * `source` matters in the settings UI: "you turned this off" and "this is off because
 * it is a browser row" are different facts, and only the first is something to undo.
 *
 * @param {Array<{ id: string, name: string }>} rows - the composed rows, in order.
 * @param {Record<string, { sync: boolean }>} overrides - persisted per-row choices.
 * @returns {Array<{ id: string, name: string, sync: boolean, source: 'default' | 'explicit', reason: string }>}
 */
export function resolveSwitches(rows, overrides) {
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (typeof row?.id !== 'string' || seen.has(row.id)) continue
    seen.add(row.id)
    const verdict = classifyRow(row.name)
    const explicit = overrides[row.id]
    if (explicit !== undefined) {
      out.push({ id: row.id, name: row.name, sync: explicit.sync, source: 'explicit', reason: 'set by hand' })
      continue
    }
    out.push({
      id: row.id,
      name: row.name,
      sync: !verdict.browserOnly,
      source: 'default',
      reason: verdict.reason,
    })
  }
  return out
}

/**
 * The rows a node must not load, as the profile patch's disable list.
 *
 * `@deepseek-ai/dsh-base` and `@local/dsh-fleet-brain` are never listed: they are the
 * node's own composition, and disabling either one leaves a node that starts and does
 * nothing.
 *
 * @param {Array<{ id: string, name: string, sync: boolean }>} resolved
 * @param {readonly string[]} keep - row ids that are the node's composition itself.
 * @returns {string[]}
 */
export function rowsToDisable(resolved, keep = []) {
  const protectedIds = new Set(['web-runtime', 'brain-runtime', ...keep])
  return resolved
    .filter(row => !row.sync && !protectedIds.has(row.id))
    .map(row => row.id)
}

/**
 * Render the node patch's disable block.
 *
 * Commented with *why* each row is off, because this file lands on somebody's server
 * and the next person to read it needs to know whether turning one back on is safe.
 * @param {Array<{ id: string, name: string, sync: boolean, source: string, reason: string }>} resolved
 * @param {readonly string[]} keep
 * @returns {string}
 */
export function renderSyncBlock(resolved, keep = []) {
  const off = resolved.filter(row => !row.sync && !['web-runtime', 'brain-runtime', ...keep].includes(row.id))
  if (off.length === 0) return ''
  const lines = [
    '',
    '# ── rows this desktop does not send to this node ────────────────────────────',
    '#',
    '# Written from the desktop\'s per-plugin switches. An "off" row is absent from the',
    '# node composition rather than loaded-and-disabled: a disabled row still costs its',
    '# module load, and one that needs a browser would still fail to start.',
  ]
  for (const row of off) {
    lines.push(`#   ${row.id}: ${row.reason}${row.source === 'explicit' ? ' (turned off by hand)' : ''}`)
    lines.push(`- id: ${row.id}`)
    lines.push('  disabled: true')
  }
  return `${lines.join('\n')}\n`
}
