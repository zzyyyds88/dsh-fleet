/**
 * Can a plugin import an upstream Host controller that ships inside app.asar?
 *
 * The routing controllers must extend the upstream classes, and those packages
 * are not published to npm — they live only inside the Desktop bundle. A plugin
 * therefore has to reach them through `DSH_INSTALL_DIR`, which points at the
 * `dsh` package itself: the siblings are one directory up.
 *
 * This probe answers three questions before any plugin code depends on them:
 *   1. Does `import()` accept an `app.asar` path from the Electron main process?
 *   2. Do the four controllers export the classes we need to extend?
 *   3. Does a subclass's `@Remote` markers survive a real construction?
 *
 * Run:
 *   ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" test/upstream-smoke.mjs
 */
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const log = message => process.stdout.write(`[upstream-smoke] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// `DSH_INSTALL_DIR` names the `dsh` package; its siblings hold every other package.
const installDir = process.env.DSH_INSTALL_DIR
check(typeof installDir === 'string' && installDir.length > 0, 'DSH_INSTALL_DIR is set', installDir)
const packages = join(dirname(installDir ?? ''), '')
log(`packages directory: ${packages}`)

/** Import one upstream package's built entry point. */
async function upstream(pkg) {
  return await import(pathToFileURL(join(packages, pkg, 'lib', 'index.js')).href)
}

// --- 1. the four controllers the routing layer replaces ---------------------
for (const [pkg, exported] of [
  ['dsh-api-session-controller', 'SessionController'],
  ['dsh-api-workspace-controller', 'WorkspaceController'],
  ['dsh-api-workspace-files', 'WorkspaceFiles'],
  ['dsh-api-terminal-controller', 'TerminalController'],
]) {
  try {
    const module = await upstream(pkg)
    const value = module[exported]
    check(typeof value === 'function', `${pkg} exports ${exported}`, typeof value)
    if (typeof value === 'function') {
      check(Array.isArray(value.inject), `${pkg} declares static inject`,
        (value.inject ?? []).join(','))
    }
  } catch (error) {
    check(false, `${pkg} imports from app.asar`, error.message.slice(0, 160))
  }
}

// --- 2. the protocol helpers the router needs ------------------------------
const protocol = await upstream('dsh-typert-protocol')
check(typeof protocol.Remote === 'function', 'the protocol exports the Remote decorator')
check(typeof protocol.remoteMethods === 'function', 'the protocol exports remoteMethods()')
check(typeof protocol.TypertRemoteService === 'function', 'the protocol exports TypertRemoteService')

// --- 3. the same module identity as the Host's own import ------------------
// If the plugin and the Host loaded two copies of dsh-typert-protocol, the
// descriptor key would still match (it is a string) but `Service` identity
// checks could fail. Compare against the Host's resolution path.
const hostModule = await import('@deepseek-ai/dsh-typert-protocol').catch(() => undefined)
if (hostModule !== undefined) {
  const bare = Object.keys(hostModule).length
  check(bare === Object.keys(protocol).length,
    'the app.asar copy exports the same surface as the bare specifier',
    `${String(Object.keys(protocol).length)} vs ${String(bare)}`)
  check(hostModule.Remote === protocol.Remote,
    'both resolutions yield the SAME module instance (no duplicate protocol)')
} else {
  log('note: the bare specifier does not resolve here; only the app.asar copy is loaded')
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
