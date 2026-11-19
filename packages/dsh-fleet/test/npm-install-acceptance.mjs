/**
 * The npm route, executed for real on a node — the fallback that makes an upstream DSH
 * release followable without anyone pre-building an artefact.
 *
 * This is the piece `version-unit` cannot prove. It checks the *text* of the script (that it
 * writes a stamp, that it passes `--os/--cpu/--libc`, that it does not `--ignore-scripts`);
 * only running it proves that `npm install @deepseek-ai/dsh@<v>` on this machine leaves a
 * tree that (a) reports the right version, (b) carries the stamp that stops the next connect
 * from reinstalling, (c) resolved the **node's** native packages rather than somebody else's,
 * and (d) has `node-pty`'s `spawn-helper` executable, which is the one mode `tar` cannot
 * carry and the one failure that only shows up when a terminal is first opened.
 *
 * It installs into a scratch directory so a node's live runtime is never touched:
 *
 *   ~/.dsh-fleet/.npm-test/runtime   ← becomes the runtime
 *   ~/.dsh-fleet/.npm-test/run       ← removed afterwards
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 3 **this node cannot reach a registry** —
 * that is a property of the network this deployment sits behind, not of the code under test,
 * so the runner records it as SKIP with the reason rather than as a failure.
 *
 * Run:
 *   DSH_FLEET_TEST_HOST=… DSH_FLEET_TEST_USER=… DSH_FLEET_TEST_PASSWORD=… \
 *   node test/npm-install-acceptance.mjs [--version 0.2.2-rc.5]
 */
import { nodeExec, nodeRun } from './node.mjs'
import { parseStamp, npmPlatformFlags, npmInstallScript, RUNTIME_BUILD } from '../src/remote/artefact.js'

const log = message => process.stdout.write(`[npm-install-acceptance] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const version = value('version', process.env.DSH_INSTALL_VERSION ?? '0.2.2-rc.5')

/**
 * Quote one string so `sh -c` receives it unchanged.
 *
 * The script contains single quotes of its own (it is shell), and a naive `replaceAll` turns
 * those into a quoting bug that reads as a truncated install. The POSIX rule is to close the
 * quote, emit an escaped quote, and reopen it.
 * @param {string} text
 * @returns {string}
 */
function shellQuote(text) {
  return text.replaceAll("'", `'\\''`)
}

// ---- what this machine is ---------------------------------------------------
// The same facts `RemoteHost.probe()` produces, read here so the script under test is built
// from the node's own answers rather than from this test's assumptions.
const probe = await nodeExec(
  `uname -s; uname -m; node -v; command -v npm; `
  + `( (ldd --version 2>/dev/null || true) | head -1 ); ls /lib/ld-musl-* 2>/dev/null | head -1`,
)
const [os, arch, nodeVersion, npmPath, libcLine, muslLine] = probe
  .split('\n')
  .map(line => line.trim())
  .concat(['', '', '', '', '', ''])
  .slice(0, 6)
check(npmPath !== '', 'the node has npm, which is all this route needs', npmPath)
if (npmPath === '') {
  log('FAILED: no npm on this node — the npm route is unreachable here by definition')
  process.exit(1)
}
const major = Number.parseInt(nodeVersion.replace(/^v/u, ''), 10)
check(Number.isFinite(major), 'and reports a readable Node version', nodeVersion)

const flags = npmPlatformFlags({ os, arch, libc: `${libcLine}${muslLine}`.toLowerCase() })
check(flags.length > 0, 'the platform maps to npm flags', flags.join(' '))

// ---- the script the plugin would run ---------------------------------------
const root = '~/.dsh-fleet/.npm-test'
const runtime = `${root}/runtime`
const cli = `${runtime}/node_modules/@deepseek-ai/dsh/lib/bin.js`
const script = npmInstallScript({ version, runtime, cli, flags })

await nodeExec(`rm -rf ${root} && mkdir -p ${root}`)
log(`installing ${version} on the node with: npm install ${flags.join(' ')}`)
const started = Date.now()
// The plugin's own ceiling is 20 minutes; this outer one only exists so a wedged channel
// cannot hold the suite forever.
const installed = await nodeRun(`sh -c '${shellQuote(script)}'`, { timeoutMs: 1_800_000 })
const elapsed = Math.round((Date.now() - started) / 1000)
log(`install took ${String(elapsed)}s`)
if (installed.code !== 0 || installed.stderr.trim().length > 0) {
  log(`install exited ${String(installed.code)}${installed.timedOut ? ' (cut off by this test)' : ''}`)
  for (const line of installed.stderr.trim().split('\n').slice(-8)) log(`  stderr: ${line.trim()}`)
}
// A registry this node cannot reach is a property of the deployment, not of the code: report
// it as SKIP (exit 3) with the registry's own words, the way `artefact-acceptance` does.
if (installed.code !== 0 && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|registry|403|404 Not Found/u.test(installed.stderr)) {
  log(`SKIP: this node could not reach a registry — ${installed.stderr.trim().replaceAll('\n', ' ').slice(-200)}`)
  await nodeExec(`rm -rf ${root}`)
  process.exit(3)
}
check(installed.code === 0, 'the npm install succeeds on the node itself',
  `exit ${String(installed.code)}: ${installed.stderr.trim().split('\n').at(-1) ?? 'no output'}`)

// ---- what it left behind ---------------------------------------------------
const lines = installed.stdout.trim().split('\n').map(line => line.trim()).filter(line => line !== '')
const reported = lines.find(line => /^\d+\.\d+\.\d+/u.test(line)) ?? ''
check(reported === version, 'the runtime it built reports the requested version', reported)
// Engines are **reported, not enforced** — and this is the assertion that pins that down.
// Measured: this node runs Node v22.20.0, and DSH 0.2.2-rc.5 declares `engines.node
// >=24.9.0`. The artefact route never read that field at all, so turning it into a refusal
// just because the install came from npm would reject a machine that has been serving
// sessions. What must happen instead: install, work, and say so out loud.
const mismatch = installed.stdout.match(/ENGINE_MISMATCH (\S+) (\S+)/u)
if (mismatch === null) {
  check(true, 'the node satisfies the release engines', nodeVersion)
} else {
  check(mismatch[1] === nodeVersion.replace(/^v/u, ''),
    'a node below the declared engines is reported, not refused',
    `node ${mismatch[1]} < engines ${mismatch[2]}`)
  check(reported === version,
    'and it was installed anyway, because the artefact route never checked either')
}

// The stamp is the whole difference between "a one-minute install" and "a one-minute connect":
// without it `inspectRuntime` reads the tree as predating stamps and reinstalls every time.
const stamp = await nodeExec(`cat ${runtime}/.fleet-artefact.json 2>/dev/null || echo`)
const parsed = parseStamp(stamp)
check(parsed.build === RUNTIME_BUILD, 'the tree is stamped with this build',
  `${stamp.trim()} → build ${String(parsed.build)}`)
check(parsed.via === 'npm', 'and says the node resolved it, not that it downloaded an artefact',
  String(parsed.via))

// ---- the natives are the node's own ---------------------------------------
// `--os/--cpu/--libc` is what makes this true. A resolve without them picks the machine that
// ran npm, and the failure lands on the first terminal or the first image read.
//
// The platform packages are the ones that matter, not the wrapper names: a wrapper
// (`sharp`, `sherpa-onnx-node`, `koffi`) is pure JS around a binary that lives in
// `@img/…`, `sherpa-onnx-<os>-<arch>` or `@koromix/…`. A tree with the wrapper and the wrong
// binary is a tree that fails at first use.
const natives = await nodeExec(
  `ls ${runtime}/node_modules/@img 2>/dev/null | tr '\\n' ' '; echo; `
  + `ls ${runtime}/node_modules | grep -E '^(sherpa-onnx|node-pty|koffi)' | tr '\\n' ' '; echo; `
  + `ls ${runtime}/node_modules/@koromix 2>/dev/null | tr '\\n' ' '; echo`,
)
const nativeText = natives.replaceAll('\n', ' ')
check(/sharp-linux-x64/u.test(nativeText), 'image support resolved to the Linux x64 build',
  nativeText.slice(0, 120))
check(/koffi-linux-x64/u.test(nativeText), 'and the FFI runtime did')
check(/sherpa-onnx-linux-x64/u.test(nativeText), 'and the speech runtime did')
check(/node-pty/u.test(nativeText), 'while the PTY wrapper is the ordinary one')
// The **platform** packages only: `@img/sharp-wasm32` is a legitimate fallback every install
// carries, and `node-pty` ships prebuilds for every OS inside its own tarball. What must not
// appear is a *resolved* package for another platform — that is what the flags prevent.
check(!/win32-x64|win32-arm64|darwin-x64/u.test(nativeText),
  'and nothing resolved for a platform this node is not',
  nativeText.match(/\S*(?:win32|darwin)-\S*/u)?.[0])
// koffi's loader checks `@koromix/koffi-<platform>` **before** `build/`, so a stray
// `build/win32_x64` from a packer would be shadowed and invisible. Check it explicitly: the
// npm route must not produce one at all.
const koffiBuild = await nodeExec(`test -d ${runtime}/node_modules/koffi/build && echo present || echo absent`)
check(koffiBuild.trim() === 'absent',
  'and no packer-built koffi tree, which would shadow the resolved platform package',
  koffiBuild.trim())

// ---- the failure that only shows up at first terminal use ------------------
// `tar` cannot carry the exec bit on a Windows packer, so the install restores it. If this
// file is not executable the PTY opens a shell that dies immediately, with no message that
// points here.
const helper = await nodeExec(
  `for f in ${runtime}/node_modules/node-pty/prebuilds/*/spawn-helper; do `
  + `[ -f "$f" ] && printf '%s %s\\n' "$f" "$( [ -x "$f" ] && echo x || echo no-x )"; done`,
)
const helpers = helper.trim().split('\n').filter(line => line.trim() !== '')
check(helpers.length > 0, 'node-pty ships its spawn helper', helpers.map(line => line.split(' ')[1]).join(','))
check(helpers.every(line => line.endsWith(' x')),
  'and every one of them is executable, which is what a terminal needs',
  helpers.join(' | ').slice(0, 160))

// ---- it actually starts ----------------------------------------------------
const runs = await nodeExec(`node ${cli} --version 2>&1 | tail -2`)
check(runs.trim() === version, 'the runtime imports and reports its version', runs.trim())
const helps = await nodeExec(`node ${cli} --help 2>&1 | head -3`)
check(helps.trim().length > 0 && !/Cannot find|MODULE_NOT_FOUND/u.test(helps),
  'and its CLI resolves its own dependencies', helps.trim().split('\n')[0])

// ---- a second install is cheap and changes nothing -------------------------
// The stamp is what makes the *next connect* skip this step entirely, so the point here is
// that the script is re-runnable without leaving the node in a different state.
const again = await nodeRun(`sh -c '${shellQuote(script)}'`, { timeoutMs: 1_800_000 })
check(again.code === 0, 'running the same install again succeeds',
  `exit ${String(again.code)}: ${again.stderr.trim().split('\n').at(-1) ?? 'no output'}`)
const stampAgain = await nodeExec(`cat ${runtime}/.fleet-artefact.json 2>/dev/null || echo`)
check(parseStamp(stampAgain).build === RUNTIME_BUILD, 'and leaves the same stamp behind',
  stampAgain.trim())

await nodeExec(`rm -rf ${root}`)
log(`cleaned ${root}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
