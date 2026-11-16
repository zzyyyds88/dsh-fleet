/**
 * Assert the brain composition is what a brain needs — and nothing a browser needs.
 *
 * This is the guard that makes the generated patch trustworthy. Regenerating after an
 * upstream bump is cheap; knowing whether the result still *is* a brain is not, so the
 * invariants are asserted rather than eyeballed:
 *
 *   1. every Remote controller the desktop app calls has a row,
 *   2. the transport rows exist (webserver, /api, launch-token auth),
 *   3. the runtime glue is ours, not upstream's SPA server,
 *   4. no `dsh-client-ui-*` row survives,
 *   5. the agent-plane disables are present (a brain mounts tools via presets),
 *   6. every preset the patch lists actually exists on disk,
 *   7. the whole thing parses as YAML.
 *
 * Usage: node scripts/check-composition.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = join(PKG, 'cordis.patch.yml')

const failures = []
const log = message => process.stderr.write(`[check-composition] ${message}\n`)
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const text = readFileSync(PATCH, 'utf8')

/** Every row id the patch names, whether inserted or targeted. */
function rowIds(source) {
  const ids = new Set()
  for (const match of source.matchAll(/^\s*- id: ([a-z0-9-]+)$/gmu)) ids.add(match[1])
  return ids
}
const ids = rowIds(text)

// ---- 1. the Remote controllers the desktop app actually calls ---------------
// Each of these is a namespace the fleet plugin routes into. Missing one means the
// node answers `session/list` and then fails whichever screen needs that endpoint.
const CONTROLLERS = [
  ['session-controller', 'session/* — list, create, prompt, follow, rename'],
  ['workspace-controller', 'workspace/* — list, create, pinSession'],
  ['workspace-files', 'workspaceFiles/* — read, readBytes, stat, list, search, changes'],
  ['job-controller', 'job/* — background job records'],
  ['terminal-controller', 'terminal/* — list, watch'],
  ['settings-controller', 'settings/* and credentials/*'],
  ['plugin-inventory', 'plugin inventory reads'],
]
for (const [id, what] of CONTROLLERS) check(ids.has(id), `controller row: ${id}`, what)

// ---- 2. the transport the SSH tunnel terminates in -------------------------
// The launch token is minted by `dsh-client-connection`'s Host service
// (`connection.authenticatedUrl()`), which is also what mints the browser cookie
// when the token comes back. Releases differ on whether they ship a *separate*
// `host-authentication-token` row: `0.2.2-rc.3` does not, and requiring that row
// here would fail a composition that boots fine. So this list names what a brain
// genuinely cannot work without.
const TRANSPORT = [
  ['webserver', 'the HTTP listener'],
  ['connection', 'the /api prefix, its trust fence, and the launch token'],
  ['api-remotes', 'the forwarded Cordis event source'],
  ['web-startup', 'the --host/--port flag provider'],
]
for (const [id, what] of TRANSPORT) check(ids.has(id), `transport row: ${id}`, what)

// ---- 3. the runtime glue is ours, and the SPA server is not ----------------
check(ids.has('brain-runtime'), 'the brain provides its own runtime row')
check(text.includes("@local/dsh-fleet-brain/runtime"), 'and it points at this package')
check(!ids.has('web-runtime'),
  'upstream web-runtime (SPA dist + browser handoff) is absent',
  ids.has('web-runtime') ? 'a node would try to serve a frontend it does not have' : undefined)

// ---- 4. nothing browser-only survives -------------------------------------
const uiRows = [...text.matchAll(/name: '(@deepseek-ai\/dsh-client-ui-[^']+)'/gu)].map(m => m[1])
check(uiRows.length === 0, 'no dsh-client-ui-* row is composed', uiRows.join(',') || undefined)
for (const dropped of ['modules', 'client-hmr', 'open-in-app', 'directory-picker', 'product-analytics']) {
  check(!ids.has(dropped), `browser-only row dropped: ${dropped}`)
}

// ---- 5. the agent plane is delegated to presets ----------------------------
// A brain serves the same Agent as the desktop, so it needs the same arrangement:
// base keeps the tool rows for the TUI, and the Web surface (and a brain) disable
// them here so each Session mounts a preset instead.
const AGENT_PLANE = ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill', 'tool-web']
for (const id of AGENT_PLANE) {
  const disabled = new RegExp(`^- id: ${id}\\n  disabled: true$`, 'mu').test(text)
  check(disabled, `agent-plane row disabled for presets: ${id}`)
}
check(ids.has('agent-preset-registry'), 'the preset registry is composed')

// ---- 6. every declared preset exists --------------------------------------
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
const declared = manifest.dsh.bundle.patch.filter(file => file.includes('presets/'))
for (const file of declared) {
  check(existsSync(join(PKG, file)), `declared patch file exists: ${file}`)
}
const onDisk = readdirSync(join(PKG, 'presets')).filter(file => file.endsWith('.yml'))
check(onDisk.length === declared.length,
  'every preset on disk is declared in dsh.bundle.patch',
  `${String(onDisk.length)} on disk, ${String(declared.length)} declared`)

// ---- 7. it parses ---------------------------------------------------------
try {
  // The YAML parser ships inside the DSH installation, so it is borrowed rather than
  // added as a dependency — this package must stay installable with no dependencies.
  const install = process.env.DSH_INSTALL_DIR
  const candidates = [
    install === undefined ? undefined : join(install, '..', '..', 'yaml', 'dist', 'index.js'),
  ].filter(Boolean)
  let yaml
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const mod = await import(new URL(`file://${candidate.replaceAll('\\', '/')}`).href)
    yaml = mod.default ?? mod
    break
  }
  if (yaml === undefined) {
    log('note: no YAML parser available; skipping the parse check')
  } else {
    // `!!js` is DSH's own tag; leave it unresolved, as the Loader does.
    const parsed = yaml.parse(text, { logLevel: 'silent' })
    check(Array.isArray(parsed), 'the patch is a YAML list')
    const rowCount = parsed.reduce((total, entry) => total + (entry.insert?.length ?? 0) + (entry.id === undefined ? 0 : 1), 0)
    // A floor, not an exact count: the number follows the upstream release, and this
    // check exists to catch a *collapsed* composition, not a row being added or
    // removed upstream. `sync-from-upstream` is where an exact diff is reviewed.
    check(rowCount >= 50, 'the patch composes a full Host', `${String(rowCount)} rows`)
  }
} catch (error) {
  check(false, 'the patch parses as YAML', error.message.split('\n')[0])
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log(`all checks passed (${String(ids.size)} distinct row ids)`)
}
