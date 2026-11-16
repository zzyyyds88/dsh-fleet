/**
 * Regenerate this bundle's patch layer from the official `@deepseek-ai/dsh-web-app`.
 *
 * ## Why this file exists
 *
 * A node must be a **brain**: it serves the Remote API and runs agents, and it
 * serves no browser at all. Upstream ships no such bundle — the shipped ones are
 * `base` (core, no Host), `web-app` (core + browser surface), `headless` (one-shot,
 * no Host/HTTP), `acp-app`, `sdk-app`, `sdk-minimal`.
 *
 * `web-app` is the only shipped composition with a Host, an HTTP server and the
 * Remote API, so a brain is `web-app` minus its browser surface. Writing that
 * subtraction by hand would rot: `web-app` is 621 lines and gains rows every
 * release. So this script derives it:
 *
 *   keep  — every host-plane row (the Remote controllers, the gateway transport,
 *           the webserver, the workspace/schedule/settings services, the agent
 *           preset registry).
 *   drop  — every `@deepseek-ai/dsh-client-ui-*` row (a window the node lacks),
 *           plus the browser-only surface rows listed in `DROPPED` below.
 *   replace — `web-runtime` (which mounts the SPA dist) by `brain-runtime`.
 *
 * Everything kept is copied **verbatim**, so a change upstream shows up as a diff in
 * this package rather than as a silent divergence.
 *
 * ## Which upstream: the INSTALLED release, not master
 *
 * This matters. `master` is ahead of any release, and a composition generated from it
 * names rows that release does not ship — the first attempt here produced an
 * `authentication-token` row that the installed `0.2.2-rc.3` does not have, and the
 * node booted with "1 entry did not activate". The brain must describe the runtime it
 * will boot inside, so the **installed** patch is the default source, and the git
 * checkout is only the fallback when no installation is configured.
 *
 * ## Usage
 *
 * ```bash
 * # Default: read the DSH installation this profile runs (DSH_INSTALL_DIR).
 * node scripts/sync-from-upstream.mjs
 *
 * # Or a checkout, when comparing releases or working without an installation.
 * DSH_SOURCE=../reference/deepseek-harness node scripts/sync-from-upstream.mjs
 * ```
 *
 * Then read the diff. A new row appearing is either a new host service the brain
 * should keep, or a new browser-only row that should join `DROPPED`. Both are
 * decisions worth seeing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')

/**
 * Locate the `dsh-web-app` package to derive from.
 *
 * Preference order: an explicit `DSH_SOURCE` checkout, then the installation this
 * profile runs (`DSH_INSTALL_DIR`, which points at `…/@deepseek-ai/dsh`). The
 * installation wins by default because the brain boots inside that exact release.
 */
function locateWebApp() {
  const explicit = process.env.DSH_SOURCE
  if (explicit !== undefined && explicit.length > 0) {
    return {
      source: 'checkout',
      packageDir: resolve(explicit, 'packages', 'bundle', 'web-app'),
    }
  }
  const install = process.env.DSH_INSTALL_DIR
  if (install !== undefined && install.length > 0) {
    return {
      source: 'installation',
      packageDir: join(resolve(install), '..', 'dsh-web-app'),
    }
  }
  // The plugin checkout is two levels below the workspace root by convention.
  return {
    source: 'checkout',
    packageDir: resolve(PKG, '..', '..', 'reference', 'deepseek-harness', 'packages', 'bundle', 'web-app'),
  }
}

const LOCATED = locateWebApp()
const UPSTREAM_PATCH = join(LOCATED.packageDir, 'cordis.patch.yml')
const UPSTREAM_PRESETS = join(LOCATED.packageDir, 'presets')

/**
 * Rows dropped in addition to the `dsh-client-ui-*` roster.
 *
 * Each one exists to drive a browser or a desktop window; a node has neither, and
 * several of them would fail to start without a frontend dist to point at.
 */
const DROPPED = Object.freeze({
  'web-runtime': 'mounts the SPA dist; replaced by brain-runtime',
  'harness-dev-context': '“inspect the harness serving this GUI” — there is no GUI',
  'client-hmr': 'browser reload chain over --watch',
  modules: 'composes window.__DSH_BOOT__ and serves /plugins/*/client.js',
  'directory-picker': 'opens a native OS dialog on the node, for the node’s own screen',
  'open-in-app': 'launches a desktop application on the node',
  'session-log-download': 'browser download dialog',
  'product-analytics': 'telemetry for a desktop app',
  'desktop-product-telemetry': 'telemetry for a desktop app',
})

/**
 * Split the `- insert:` list of the upstream patch into one block per row.
 *
 * Comment lines are carried by the row they describe rather than left behind:
 * dropping a row must drop its explanation too, or the generated file fills with
 * comments about rows that are no longer there. A comment separated from any row by
 * a blank line is treated as orphaned and dropped with it.
 */
function extractRows(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^- insert:$/u.test(line))
  if (start < 0) throw new Error(`${UPSTREAM_PATCH}: no "- insert:" list found`)
  /** @type {string[][]} */
  const blocks = []
  /** Comments seen since the last row; they belong to the next row. */
  let comments = []
  /** The row being accumulated, with its comments. */
  let current
  const flush = () => {
    if (current !== undefined) blocks.push(current)
    current = undefined
  }
  for (const line of lines.slice(start + 1)) {
    if (/^    - id:/u.test(line)) {
      flush()
      current = [...comments, line]
      comments = []
      continue
    }
    // A new top-level key ends the insert list.
    if (/^- /u.test(line)) break
    if (/^    #/u.test(line)) { comments.push(line); continue }
    // Blank lines and YAML body lines: body goes to the row, blanks are dropped.
    if (/^\s*$/u.test(line)) continue
    if (current !== undefined) current.push(line)
  }
  flush()
  return blocks.map(block => {
    const header = block.find(line => /^    - id:/u.test(line))
    if (header === undefined) throw new Error(`${UPSTREAM_PATCH}: a block has no "- id:" line`)
    const id = /^    - id:\s*(.+)$/u.exec(header)
    const name = block.map(line => /^      name:\s*'?([^'\n]+?)'?$/u.exec(line)).find(Boolean)
    return {
      id: id[1].trim(),
      name: name === undefined ? '' : name[1].trim(),
      text: block.join('\n').replace(/\s+$/u, ''),
    }
  })
}

/** Rows that a brain keeps: no browser roster, no browser-only surface. */
function isBrainRow(row) {
  if (/^@deepseek-ai\/dsh-client-ui-/u.test(row.name)) return false
  return DROPPED[row.id] === undefined
}

const banner = [
  '# ══════════════════════════════════════════════════════════════════════════════',
  '# @local/dsh-fleet-brain — the node-side composition.',
  '#',
  '# A node is a BRAIN: it runs agents and serves the Remote API that the desktop',
  '# app (and ds-harness-remote from a phone) talks to. It serves no browser, so',
  '# this layer is `@deepseek-ai/dsh-web-app` minus its browser surface.',
  '#',
  '# GENERATED — do not hand-edit the row blocks below.',
  '#   node scripts/sync-from-upstream.mjs   (then read the diff)',
  '#',
  '# Every row here is copied verbatim from the official patch of the DSH release',
  '# this profile runs, so an upstream change appears as a reviewable diff instead',
  '# of a silent divergence. See scripts/sync-from-upstream.mjs for the keep/drop',
  '# rule and the reason each dropped row is dropped.',
  '# ══════════════════════════════════════════════════════════════════════════════',
  '',
].join('\n')

function render() {
  if (!existsSync(UPSTREAM_PATCH)) {
    throw new Error(
      `${UPSTREAM_PATCH} is missing. Clone the DSH source and point DSH_SOURCE at it:\n`
      + '  git -c http.proxy= -c https.proxy= clone --depth 1 \\\n'
      + '    https://git.yylx.win/https://github.com/deepseek-ai/deepseek-harness.git \\\n'
      + '    reference/deepseek-harness\n'
      + '  DSH_SOURCE=reference/deepseek-harness node scripts/sync-from-upstream.mjs',
    )
  }
  const upstream = readFileSync(UPSTREAM_PATCH, 'utf8')
  const rows = extractRows(upstream)

  /**
   * The two surface values `web-app` restates over `base`. `system-prompt` gives the
   * agent its persona; `session-query-sqlite` keeps full-text search off until the
   * first query. Both are surface-neutral, so a brain keeps them verbatim.
   */
  const surfaceValues = upstream
    .slice(0, upstream.indexOf('\n- insert:'))
    .split('\n')
    .filter(line => !/^#/u.test(line))
    .join('\n')
    .trim()

  /**
   * `web-app` also disables the base's agent-plane rows, because the Web surface
   * mounts them per Session through agent presets. A brain needs the same thing for
   * the same reason — its sessions are normal Sessions with presets.
   */
  const agentPlane = upstream
    .slice(upstream.indexOf('# ── the agent plane moves behind agent presets'))
    .split('\n')
    .filter(line => !/^#/u.test(line))
    .join('\n')
    .trim()

  const kept = rows.filter(isBrainRow)
  const dropped = rows.filter(row => !isBrainRow(row) && !/^@deepseek-ai\/dsh-client-ui-/u.test(row.name))
  const uiDropped = rows.filter(row => /^@deepseek-ai\/dsh-client-ui-/u.test(row.name))

  const parts = [
    banner,
    '# ── surface values shared with the Web surface ───────────────────────────────',
    '',
    surfaceValues,
    '',
    '# ── host-plane rows: the Remote API, its transport, and the services behind it ─',
    '',
    '- insert:',
    kept.map(row => row.text).join('\n\n'),
    '',
    '    # The brain’s own runtime glue: prints the entry URL and provides `webApp`',
    '    # WITHOUT mounting a frontend dist. Replaces the upstream `web-runtime` row,',
    '    # which would try to serve a SPA this node does not have.',
    '    - id: brain-runtime',
    '      name: \'@local/dsh-fleet-brain/runtime\'',
    '      inject: [webStartup]',
    '      config:',
    '        printUrl: true',
    '',
    '# ── the agent plane moves behind agent presets (same as the Web surface) ─────',
    '',
    agentPlane,
    '',
    '# ── rows no brain needs ──────────────────────────────────────────────────────',
    '#',
    '# 57 `dsh-client-ui-*` rows are absent above: a node renders nothing, so their',
    '# whole reason to exist is missing. The rest each drive a browser or a desktop',
    '# window; the reason is recorded here so the next reader does not re-add one.',
    '#',
    ...Object.entries(DROPPED).map(([id, why]) => `#   ${id.padEnd(28)} ${why}`),
    '',
  ]

  const text = parts.join('\n').replace(/\n{4,}/gu, '\n\n\n')
  return { text, kept, dropped, uiDropped, rows }
}

const { text, kept, dropped, uiDropped, rows } = render()
const out = join(PKG, 'cordis.patch.yml')
writeFileSync(out, text, 'utf8')

// The preset declarations are data the brain must mount too: a Session on a node
// is a normal Session, and the standard preset is what gives it tools at all.
mkdirSync(join(PKG, 'presets'), { recursive: true })
const presets = ['cordis.patch.yml', 'minimal.patch.yml', 'ptc.patch.yml', 'standard.patch.yml']
for (const name of presets) {
  const from = join(UPSTREAM_PRESETS, name)
  if (!existsSync(from)) throw new Error(`${from} is missing; the upstream preset roster changed`)
  const body = readFileSync(from, 'utf8')
  writeFileSync(
    join(PKG, 'presets', name),
    `# Copied verbatim from @deepseek-ai/dsh-web-app/presets/${name}\n`
    + `# Regenerate with: node scripts/sync-from-upstream.mjs\n\n${body}`,
    'utf8',
  )
}

process.stdout.write([
  `[sync-from-upstream] read ${UPSTREAM_PATCH}`,
  `[sync-from-upstream] rows: ${String(rows.length)} total, ${String(kept.length)} kept, `
  + `${String(dropped.length)} dropped (browser surface), ${String(uiDropped.length)} dropped (UI roster)`,
  `[sync-from-upstream] wrote ${out}`,
  `[sync-from-upstream] wrote ${String(presets.length)} preset files`,
  '',
].join('\n'))
