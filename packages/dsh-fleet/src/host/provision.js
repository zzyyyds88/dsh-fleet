/**
 * Make a node's resident host usable as a brain, without the user touching it.
 *
 * A node is a **separate DSH installation** with its own `~/.dsh`: its own profile,
 * its own credential store, its own model roster. A fresh node therefore starts,
 * answers `session/list`, and then fails its first prompt — there is no provider
 * route and no API key over there. That is not a routing bug, but from the desktop
 * it looks exactly like one.
 *
 * This module closes that gap by provisioning the node from this Host, in the way
 * ZCode provisions its source server:
 *
 *   1. **Model configuration** — copy this Host's effective LLM rows (provider
 *      routes, the default model, the permission preset) and write them as a
 *      `--patch` overlay the node host starts with. The overlay is a file this
 *      plugin owns, so the node's own profile is never edited.
 *   2. **Credentials** — resolve the API keys those rows name, here, and push them
 *      into the node's credential store over the node's own Remote API.
 *   3. **Brain-only composition** — disable every pure-UI row in the node's
 *      composition. A node serves an API, never a window, so the ~60 browser
 *      plugins are dead weight there. The list is derived from the installed
 *      DSH's own composed tree, so it follows an upgrade instead of going stale.
 *
 * @module @local/dsh-fleet/host/provision
 */
import { randomUUID } from 'node:crypto'

/** Path (relative to the node root) of the overlay this plugin owns. */
export const BRAIN_PATCH_FILE = '~/.dsh-fleet/run/brain.patch.yml'

/**
 * Rows copied verbatim from this Host.
 *
 * Every provider route is copied; account-backed routes are not, because they
 * carry a sign-in session that belongs to this machine, not to the node.
 */
const COPIED_ROW_IDS = Object.freeze(['agent-default-model', 'permission'])

/** A provider route worth copying: an `llm-*` row that is not an account login. */
const PROVIDER_ROW = /^@deepseek-ai\/dsh-llm-(?!.*account)/u

/**
 * A pure browser plugin: its whole reason to exist is a window the node lacks.
 *
 * Deliberately narrow. `@deepseek-ai/dsh-client-connection` and
 * `dsh-client-modules` also carry the string `client`, but they are the HTTP
 * transport and the bundle composer — the Host side depends on them, and disabling
 * either would take the Remote API down with the UI.
 */
const CLIENT_ONLY_ROW = /^@deepseek-ai\/dsh-client-ui-/u

/** Parse the `- id:` / `name:` pairs out of `dsh --dump-config` output. */
export function parseComposedRows(dump) {
  /** @type {Array<{ id: string, name: string }>} */
  const rows = []
  /** @type {{ id: string, name: string } | undefined} */
  let current
  for (const line of dump.split('\n')) {
    const id = /^- id: (.+)$/u.exec(line)
    if (id !== null) {
      current = { id: id[1].trim(), name: '' }
      rows.push(current)
      continue
    }
    if (current === undefined || current.name !== '') continue
    const name = /^\s+name: '?([^'\n]+?)'?$/u.exec(line)
    if (name !== null) current.name = name[1].trim()
  }
  return rows
}

/**
 * Which composed rows a brain does not need.
 *
 * This asks the **live** composition (via `configEditor.configuration()`) rather
 * than a hardcoded list, so a UI plugin introduced by an upgrade is dropped on the
 * next connect instead of quietly loading on every node.
 * @param {Array<{ id: string, name: string }>} rows
 * @returns {string[]}
 */
export function clientOnlyIds(rows) {
  return rows.filter(row => CLIENT_ONLY_ROW.test(row.name)).map(row => row.id)
}

/**
 * The rows of this Host that make a prompt work: provider routes, the default
 * model, and the permission preset.
 *
 * `configEditor.configuration()` is the right source: it reports the effective
 * config of every active row as plain JSON (`inherited` from the bundle layers,
 * `override` from this profile), so copying it reproduces the same roster on a
 * node whose bundles are identical — which they are, because the node runs the
 * same version.
 *
 * @param {{ configuration: () => Array<{ entry: { options: { id: string, name: string } }, inherited: Record<string, unknown>, override: Record<string, unknown> }> }} configEditor
 * @returns {Array<{ id: string, name: string, config: Record<string, unknown> }>}
 */
export function copyableRows(configEditor) {
  if (configEditor === undefined || typeof configEditor.configuration !== 'function') return []
  const out = []
  for (const row of configEditor.configuration()) {
    const id = row.entry?.options?.id
    const name = row.entry?.options?.name
    if (typeof id !== 'string' || typeof name !== 'string') continue
    if (!COPIED_ROW_IDS.includes(id) && !PROVIDER_ROW.test(name)) continue
    // Effective config: everything below this profile, plus this profile's say.
    const config = { ...(row.inherited ?? {}), ...(row.override ?? {}) }
    if (Object.keys(config).length === 0) continue
    out.push({ id, name, config })
  }
  return out
}

/**
 * Adapter defaults for the key ref, keyed by package name.
 *
 * A row's `apiKeyEnv` is only present when somebody set it explicitly; the
 * adapter's declared default is applied by its own schema at load time and never
 * reaches the composed patch text. Copying the row without the ref would therefore
 * provision a node whose provider loads fine but has no key — which is exactly the
 * failure this module exists to prevent.
 *
 * The values mirror each adapter's `Config(... apiKeyEnv ... default)`. An
 * unrecognised adapter still contributes any `*_API_KEY`-shaped string found in its
 * config (see `credentialRefsOf`), so this map only has to cover the defaults.
 */
const ADAPTER_DEFAULT_REF = Object.freeze({
  '@deepseek-ai/dsh-llm-deepseek-api-key': 'DEEPSEEK_API_KEY',
})

/** A config value that is obviously naming a credential rather than holding one. */
const REF_LIKE = /^[A-Z][A-Z0-9_]*_(?:API_KEY|KEY|TOKEN)$/u

/**
 * The credential refs those rows name.
 *
 * Three sources, in order of confidence: an explicit `apiKeyEnv`; the adapter's own
 * default for this package; and any `*_API_KEY`-shaped string in the config (which
 * covers a provider nested under `providers`).
 * @param {Array<{ name?: string, config: Record<string, unknown> }>} rows
 * @returns {string[]}
 */
export function credentialRefsOf(rows) {
  const refs = new Set()
  const noteValue = value => {
    if (typeof value === 'string' && REF_LIKE.test(value)) refs.add(value)
  }
  const walk = value => {
    if (typeof value === 'string') return noteValue(value)
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      // `apiKeyEnv` wins even when its value is an unusual ref name.
      if (key === 'apiKeyEnv' && typeof item === 'string' && item.length > 0) refs.add(item)
      else walk(item)
    }
  }
  for (const row of rows) {
    walk(row.config)
    const fallback = row.name === undefined ? undefined : ADAPTER_DEFAULT_REF[row.name]
    if (fallback !== undefined) refs.add(fallback)
  }
  return [...refs]
}

/**
 * Render the overlay the node host starts with.
 *
 * Comments are deliberate: this file lands on somebody's server, and the next
 * person to look at it should not have to guess whether it is safe to edit.
 * @param {object} plan
 * @param {Array<{ id: string, config: Record<string, unknown> }>} plan.rows
 * @param {string[]} plan.disabled - pure-UI row ids to switch off.
 * @param {string} plan.version - the DSH version this overlay was written for.
 * @returns {string}
 */
export function renderBrainPatch({ rows, disabled, version }) {
  const lines = [
    '# Managed by @local/dsh-fleet. Rewritten on every connect — edits are lost.',
    `# Written for DSH ${version}. A version change rewrites this file.`,
    '#',
    '# This profile exists so the desktop app can use this machine as a remote',
    '# brain: the Remote API and every tool stay, the browser plugins go. The model',
    '# rows below are copied from the Host so a prompt works with no local setup.',
  ]
  for (const row of rows) {
    lines.push('', `- id: ${row.id}`)
    lines.push('  config:')
    for (const line of renderYamlFields(row.config, 4)) lines.push(line)
  }
  if (disabled.length > 0) {
    lines.push('', '# Browser-only rows: a node serves an API, never a window.')
    for (const id of disabled) lines.push('', `- id: ${id}`, '  disabled: true')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Render a JSON value as YAML fields indented under `config:`.
 *
 * This is a deliberately small emitter rather than a YAML dependency: the plugin
 * ships to a bundled runtime and must not add one, and the shapes involved are
 * plain JSON from `configEditor` (scalars, lists, flat maps).
 * @param {unknown} value
 * @param {number} indent
 * @returns {string[]}
 */
function renderYamlFields(value, indent) {
  const pad = ' '.repeat(indent)
  if (value === null || typeof value !== 'object') return [`${pad}${renderScalar(value)}`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    const lines = []
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const nested = renderYamlFields(item, indent + 2)
        // Fold the first key onto the `-` line, the way hand-written YAML reads.
        lines.push(`${pad}- ${nested[0].trimStart()}`)
        for (const line of nested.slice(1)) lines.push(line)
      } else {
        lines.push(`${pad}- ${renderScalar(item)}`)
      }
    }
    return lines
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return [`${pad}{}`]
  const lines = []
  for (const [key, item] of entries) {
    const safeKey = /^[A-Za-z_][\w.-]*$/u.test(key) ? key : JSON.stringify(key)
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}${safeKey}: []`)
        continue
      }
      lines.push(`${pad}${safeKey}:`)
      for (const line of renderYamlFields(item, indent + 2)) lines.push(line)
      continue
    }
    if (item !== null && typeof item === 'object') {
      if (Object.keys(item).length === 0) {
        lines.push(`${pad}${safeKey}: {}`)
        continue
      }
      lines.push(`${pad}${safeKey}:`)
      for (const line of renderYamlFields(item, indent + 2)) lines.push(line)
      continue
    }
    lines.push(`${pad}${safeKey}: ${renderScalar(item)}`)
  }
  return lines
}

/** One YAML scalar, quoted when a bare form would be misread. */
function renderScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === undefined) return 'null'
  const text = String(value)
  if (text.length === 0) return "''"
  // Quote anything a YAML reader could coerce, plus anything with structure.
  const needsQuoting = /^(?:true|false|null|~|[-+]?\d[\d._eE+-]*)$/u.test(text)
    || /[:#{}[\],&*?|>!%@`"'\n]/u.test(text)
    || /^\s|\s$/u.test(text)
  return needsQuoting ? JSON.stringify(text) : text
}

/**
 * Read and push the plan for one node.
 *
 * Order matters: the overlay has to be on disk before the host starts, and the
 * credentials can only be pushed once the host answers.
 */
export class Provisioner {
  /**
   * @param {object} options
   * @param {() => object | undefined} options.configEditor - the local config editor, once composed.
   * @param {object | undefined} options.credentials - this Host's credential service.
   * @param {string} options.version - the DSH version both sides run.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.configEditor = options.configEditor
    this.credentials = options.credentials
    this.version = options.version
    this.log = options.log ?? (() => {})
  }

  /**
   * Everything a node needs, derived from this Host's live composition.
   *
   * The disabled list comes from the same `configuration()` call: those are the
   * rows this Host actually composed, and the node runs the identical version, so
   * its row ids (and the package each one loads) match by construction.
   */
  plan() {
    const editor = this.configEditor()
    const rows = copyableRows(editor)
    const composed = (editor?.configuration?.() ?? []).map(row => ({
      id: String(row.entry?.options?.id ?? ''),
      name: String(row.entry?.options?.name ?? ''),
    })).filter(row => row.id !== '' && row.name !== '')
    const disabled = clientOnlyIds(composed)
    return {
      rows,
      refs: credentialRefsOf(rows),
      disabled,
      version: this.version,
      text: renderBrainPatch({ rows, disabled, version: this.version }),
    }
  }

  /**
   * Resolve one credential ref here, so the node can be given the value.
   * @param {string} ref
   * @returns {Promise<string | undefined>}
   */
  async resolveKey(ref) {
    if (this.credentials === undefined) return undefined
    try {
      const hit = await this.credentials.resolve(ref)
      return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
    } catch (error) {
      this.log(`provision: could not resolve ${ref}: ${error.message}`)
      return undefined
    }
  }

  /**
   * Push the local API keys into the node's credential store.
   *
   * The node's gateway exposes `credentials/set` (`ref`, `value`) for exactly this,
   * and its store wins over that machine's environment — so this also fixes a node
   * whose `.env` holds a stale key.
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   * @param {string[]} refs
   * @returns {Promise<string[]>} the refs that were written.
   */
  async pushCredentials(gateway, refs) {
    const written = []
    for (const ref of refs) {
      const value = await this.resolveKey(ref)
      if (value === undefined) continue
      const result = await gateway.call('credentials/set', { ref, value })
      if (result.ok !== true) {
        this.log(`provision: the node refused ${ref}: ${result.error?.message ?? 'unknown reason'}`)
        continue
      }
      written.push(ref)
    }
    return written
  }
}

/** A row id that will not collide with anything the node already composes. */
export function provisionRunId() {
  return `fleet-provision-${randomUUID()}`
}
