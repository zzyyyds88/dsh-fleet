/**
 * Per-plugin "send this to nodes" switches, persisted beside the node registry.
 *
 * The decision *what* a switch means lives in `src/core/plugin-sync.js`; this is the
 * part that owns a file and the list of rows those switches apply to.
 *
 * Rows come from the Host's own `configEditor.configuration()`, the same source
 * `Provisioner` reads for the model roster. That is deliberate: the switch list has to
 * describe what this desktop actually composes, and a hard-coded list would be wrong
 * after the first upgrade.
 *
 * @module @local/dsh-fleet/host/sync-switches
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  parsePatchRowIds,
  parseSwitches,
  renderSyncBlock,
  resolveSwitches,
  rowsToDisable,
} from '../core/plugin-sync.js'
import { BRAIN_FILES } from './brain-bundle.generated.js'

/** Rows that are the node's own composition: never switchable. */
const PROTECTED = Object.freeze(['web-runtime', 'brain-runtime'])

/** Upstream bundles a node loads, whose rows are therefore always present. */
const UPSTREAM_BUNDLES = Object.freeze(['dsh-base'])

/**
 * The row ids a node's composition contains, out of the **installed** release.
 *
 * A node composes two bundles: `@deepseek-ai/dsh-base` (upstream) and
 * `@local/dsh-fleet-brain` (this plugin's patch). Both contribute rows, and a row of
 * either must never be disabled — the brain is a *subtraction* from `dsh-web-app`, not
 * from `dsh-base`, so every service `dsh-base` provides is still there and other kept
 * rows inject it.
 *
 * Reading `dsh-base` from `DSH_INSTALL_DIR` rather than embedding a copy is deliberate:
 * the composition has to describe the release this desktop actually runs, and a list
 * compiled into the plugin would be wrong the first time upstream adds a row.
 *
 * @returns {string[]} row ids from both bundles, deduplicated.
 */
function requiredRows() {
  const ids = [...parsePatchRowIds(BRAIN_FILES['cordis.patch.yml'] ?? '')]
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir.length > 0) {
    // `DSH_INSTALL_DIR` is `<app>/dsh/node_modules/@deepseek-ai/dsh`, so one level up is
    // the `@deepseek-ai` directory this release's own bundles sit in.
    const scopeDir = join(installDir, '..')
    for (const bundle of UPSTREAM_BUNDLES) {
      let text
      try {
        text = readFileSync(join(scopeDir, bundle, 'cordis.patch.yml'), 'utf8')
      } catch {
        // A bundle this plugin cannot read is reported, not guessed at: it means the
        // install layout changed, and silently locking fewer rows would take a node
        // down later with an error that names no switch.
        continue
      }
      for (const id of parsePatchRowIds(text)) if (!ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

export class SyncSwitches {
  /**
   * @param {object} options
   * @param {string} options.home - `$DSH_HOME`.
   * @param {() => object | undefined} options.configEditor - the local config editor.
   * @param {readonly string[]} [options.required] - row ids the node composition contains.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.path = join(options.home, 'fleet', 'plugins.json')
    this.configEditor = options.configEditor
    this.required = options.required ?? requiredRows()
    this.log = options.log ?? (() => {})
    /** @type {Record<string, { sync: boolean }>} */
    this.overrides = this.#read()
  }

  #read() {
    try {
      return parseSwitches(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      // A missing or unreadable file means "no opinions yet", which is exactly the
      // state a fresh install is in. It is not an error to report.
      return {}
    }
  }

  #write() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(this.overrides, undefined, 2)}\n`, 'utf8')
    } catch (error) {
      this.log(`fleet: could not save the plugin switches: ${error.message}`)
    }
  }

  /** Every row this desktop composes, whether or not it can be switched. */
  rows() {
    const editor = this.configEditor()
    if (editor === undefined || typeof editor.configuration !== 'function') return []
    const out = []
    for (const row of editor.configuration()) {
      const id = row.entry?.options?.id
      const name = row.entry?.options?.name
      if (typeof id !== 'string' || typeof name !== 'string') continue
      out.push({ id, name })
    }
    return out
  }

  /** Every row with its effective switch and where that answer came from. */
  list() {
    const resolved = resolveSwitches(this.rows(), this.overrides, this.required)
    return resolved.map(row => ({
      ...row,
      // The node's own composition is shown but not switchable: turning it off would
      // leave a node that starts and does nothing, or does not start at all.
      locked: row.locked === true || PROTECTED.includes(row.id),
    }))
  }

  /**
   * Record one decision.
   *
   * Setting a switch back to its default removes the override instead of storing the
   * same value twice — that keeps the file meaning "what I changed", so an upgrade
   * that flips a default still reaches the user who never touched it.
   * @param {string} rowId
   * @param {boolean} sync
   */
  set(rowId, sync) {
    const rows = this.rows()
    if (!rows.some(row => row.id === rowId)) {
      throw Object.assign(new Error(`no plugin row ${rowId} on this desktop`), { code: 'row-not-found' })
    }
    if (PROTECTED.includes(rowId) || this.required.includes(rowId)) {
      throw Object.assign(
        new Error(`${rowId} is what makes a node a node; it cannot be switched off`),
        { code: 'row-protected' },
      )
    }
    const verdict = resolveSwitches([rows.find(row => row.id === rowId)], {}, this.required)
      .find(row => row.id === rowId)
    if (verdict !== undefined && verdict.sync === sync) delete this.overrides[rowId]
    else this.overrides[rowId] = { sync }
    this.#write()
    return this.list().find(row => row.id === rowId)
  }

  /** The rows a node must not load, in composition order. */
  disabledRows() {
    const keep = PROTECTED.filter(id => id !== 'web-runtime' && id !== 'brain-runtime')
    return rowsToDisable(resolveSwitches(this.rows(), this.overrides, this.required), keep)
  }

  /**
   * The patch block that removes those rows on the node.
   *
   * Rendered into the node's own profile patch, which the resident host hot-reloads —
   * so flipping a switch reconfigures a running node without a restart.
   */
  render() {
    return renderSyncBlock(resolveSwitches(this.rows(), this.overrides, this.required), [])
  }
}
