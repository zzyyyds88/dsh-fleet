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
 * - **A row the node's composition contains is never switched off.** The node composes
 *   `@deepseek-ai/dsh-base` + `@local/dsh-fleet-brain`, and those bundles are generated
 *   from upstream — this plugin does not edit them per node. So "off" means the profile
 *   patch carries `- id: <row>` + `disabled: true`, which stops the row activating
 *   without making the bundle different from the one in the release. The rows that keep
 *   a node alive at all (`STRUCTURAL_ROWS`) and every row either bundle contributes are
 *   locked, because switching one off produces a node with no HTTP server rather than a
 *   leaner one. Measured.
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
 * Rows a node cannot start without.
 *
 * Measured, not inferred. Disabling any of these produced
 * `dsh: startup failed: 1 required plugin did not activate` and the node never served
 * HTTP at all, because they provide services other rows `inject` as required:
 *
 * - `web-startup` provides `webStartup`, which `webserver` and `brain-runtime` require;
 * - `webserver` provides `webServer`, which `brain-runtime` requires;
 * - `brain-runtime` is the tokenized entry point the resident host is started for;
 * - `web` provides the `web` service `tool-web`/`web-search`/`web-fetch` inject — they
 *   wait for it rather than failing, but every web capability then reports
 *   `waiting for web` instead of working.
 *
 * Everything else is a genuine choice: switching `office-kit` or `workflow-ptc` off is a
 * smaller node, which is what this whole layer is for.
 */
export const STRUCTURAL_ROWS = Object.freeze([
  'web-startup',
  'webserver',
  'web',
  'brain-runtime',
])

/**
 * Whether a row is one a node cannot run without.
 * @param {string} id
 */
export function isStructuralRow(id) {
  return STRUCTURAL_ROWS.includes(id)
}

/**
 * Resolve every row's effective switch, and say where the answer came from.
 *
 * `source` matters in the settings UI: "you turned this off" and "this is off because
 * it is a browser row" are different facts, and only the first is something to undo.
 *
 * **A row the node's own composition contains is always on, whatever its name looks
 * like.** The brain is not "the web app minus UI": it is derived from `dsh-web-app` and
 * keeps the headless halves of several `@deepseek-ai/dsh-client-*` packages —
 * `connection` (the Remote mux), `file-upload` (the attachments `session-controller`
 * injects), `locale`, `shortcuts`, `resources`, and `web-startup` (which provides
 * `webStartup` for `webserver` and `brain-runtime`). A name-shape rule alone marks all
 * of those browser-only and the node then comes up with "1 required plugin did not
 * activate", six plugins waiting for services that will never arrive, and no HTTP
 * server — measured, not theorised.
 *
 * @param {Array<{ id: string, name: string }>} rows - the composed rows, in order.
 * @param {Record<string, { sync: boolean }>} overrides - persisted per-row choices.
 * @param {Iterable<string>} [required] - row ids the node's own composition contains.
 * @returns {Array<{ id: string, name: string, sync: boolean, source: 'default' | 'explicit' | 'required', reason: string, locked: boolean }>}
 */
export function resolveSwitches(rows, overrides, required = []) {
  const requiredIds = new Set(required)
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (typeof row?.id !== 'string' || seen.has(row.id)) continue
    seen.add(row.id)
    // The node's own composition wins over both the default and a stored choice: this
    // is not "a plugin this desktop sends", it is "a row the brain is built from".
    if (requiredIds.has(row.id) || isStructuralRow(row.id)) {
      out.push({
        id: row.id,
        name: row.name,
        sync: true,
        source: 'required',
        reason: isStructuralRow(row.id)
          ? 'a node cannot start without it'
          : 'part of the node composition itself',
        locked: true,
      })
      continue
    }
    const verdict = classifyRow(row.name)
    const explicit = overrides[row.id]
    if (explicit !== undefined) {
      out.push({
        id: row.id,
        name: row.name,
        sync: explicit.sync,
        source: 'explicit',
        reason: 'set by hand',
        locked: false,
      })
      continue
    }
    out.push({
      id: row.id,
      name: row.name,
      sync: !verdict.browserOnly,
      source: 'default',
      reason: verdict.reason,
      locked: false,
    })
  }
  return out
}

/**
 * The row ids a patch file inserts or configures.
 *
 * This is how the node's own composition tells the switch list which rows it needs. The
 * file is generated (`packages/dsh-fleet-brain/cordis.patch.yml`), so parsing it is the
 * only way to know without duplicating the composition in a second list that would go
 * stale — and a stale list here means a node that refuses to start.
 *
 * Only `- id: <name>` lines are read. That is deliberately narrower than YAML: the file
 * is machine-written and every row it inserts carries exactly that key.
 *
 * @param {string} text - a `cordis.patch.yml`.
 * @returns {string[]} row ids, in file order.
 */
export function parsePatchRowIds(text) {
  if (typeof text !== 'string') return []
  const ids = []
  for (const line of text.split('\n')) {
    const match = /^\s*-\s*id:\s*(\S+)\s*$/u.exec(line)
    if (match !== null && !ids.includes(match[1])) ids.push(match[1])
  }
  return ids
}

/**
 * The rows a node must not load, as the profile patch's disable list.
 *
 * A row the node's composition requires is never listed, and neither is the composition
 * itself: disabling either leaves a node that starts and does nothing (or does not start
 * at all).
 *
 * @param {Array<{ id: string, name: string, sync: boolean, locked?: boolean }>} resolved
 * @param {readonly string[]} keep - row ids that are the node's composition itself.
 * @returns {string[]}
 */
export function rowsToDisable(resolved, keep = []) {
  const protectedIds = new Set(['web-runtime', 'brain-runtime', ...keep])
  return resolved
    .filter(row => !row.sync && !row.locked && !protectedIds.has(row.id))
    .map(row => row.id)
}

/**
 * Render the node patch's disable block.
 *
 * Commented with *why* each row is off, because this file lands on somebody's server
 * and the next person to read it needs to know whether turning one back on is safe.
 * @param {Array<{ id: string, name: string, sync: boolean, source: string, reason: string, locked?: boolean }>} resolved
 * @param {readonly string[]} keep
 * @returns {string}
 */
export function renderSyncBlock(resolved, keep = []) {
  const off = resolved.filter(row => !row.sync && !row.locked
    && !['web-runtime', 'brain-runtime', ...keep].includes(row.id))
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
