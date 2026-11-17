/**
 * The artefact install, executed for real on a node — no Host, no npm.
 *
 * This is the piece `version-unit` cannot prove: that the generated shell script
 * actually downloads 169 MB, verifies it, unpacks it into a working runtime, and that
 * the runtime it leaves behind **starts**. A unit test can only check the script's text;
 * the failure modes here (tar flags, a staging directory that already exists, a
 * checksum file with CRLF, `node bin.js --version` exiting non-zero on a fresh tree) are
 * all things that only appear when it runs.
 *
 * It installs into a scratch directory so a node's live runtime is never touched:
 *
 *   ~/.dsh-fleet/.artefact-test/runtime   ← becomes the runtime
 *   ~/.dsh-fleet/.artefact-test/run       ← removed afterwards
 *
 * Run:
 *   DSH_FLEET_TEST_HOST=… DSH_FLEET_TEST_USER=… DSH_FLEET_TEST_PASSWORD=… \
 *   node test/artefact-acceptance.mjs [--version 0.2.2-rc.3] [--platform linux-x64]
 */
import { nodeExec } from './node.mjs'
import { platformTag } from '../src/remote/artefact.js'

const log = message => process.stdout.write(`[artefact-acceptance] ${message}\n`)
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
const version = value('version', process.env.DSH_INSTALL_VERSION ?? '0.2.2-rc.3')
const platform = value('platform', 'linux-x64')

// The plugin builds the tag from the node's own uname; use the same rule here so this
// test would notice if the mapping drifted.
const probe = await nodeExec('uname -s; uname -m; command -v curl; command -v tar; command -v sha256sum')
const [os, arch, curl, tar, sha] = probe.trim().split('\n').map(line => line.trim())
check(curl !== '', 'the node has curl', curl)
check(tar !== '', 'the node has tar', tar)
check(sha !== '', 'the node has sha256sum', sha)
check(platformTag({ os, arch }) === platform,
  `the node's own uname maps to ${platform}`, `${os}/${arch} → ${String(platformTag({ os, arch }))}`)

const root = '~/.dsh-fleet/.artefact-test'
const runtime = `${root}/runtime`
const cli = `${runtime}/node_modules/@deepseek-ai/dsh/lib/bin.js`

// Import the real script generator: the test must run the bytes the plugin would.
const { installScript, artefactUrls, rollbackScript } = await import('../src/remote/artefact.js')
const urls = artefactUrls({ version, platform })
const script = installScript({ version, runtime, cli, urls })

await nodeExec(`rm -rf ${root} && mkdir -p ${root}`)
log(`installing ${version} on ${platform} into ${root}`)
const started = Date.now()
const installed = await nodeExec(`sh -c '${script.replaceAll("'", `'\\''`)}'`, 900_000)
const elapsed = Math.round((Date.now() - started) / 1000)
log(`install took ${String(elapsed)}s`)
const lastLine = installed.trim().split('\n').at(-1) ?? ''
check(lastLine.includes(version), 'the installed CLI reports the requested version', lastLine)

// ---- what the install left behind -----------------------------------------
// Each line is a labelled answer rather than a bare value: a failed `test` prints
// nothing, and an unlabelled empty line silently shifts every later field.
const tree = await nodeExec(
  `test -f ${cli} && echo cli=yes || echo cli=no; `
  + `test -d ${runtime}/node_modules/@deepseek-ai/dsh/node_modules && echo nested=yes || echo nested=no; `
  + `echo packages=$(ls ${runtime}/node_modules | wc -l); `
  + `echo size=$(du -sm ${runtime} | cut -f1)`,
)
const field = name => tree.trim().split('\n')
  .map(line => line.trim())
  .find(line => line.startsWith(`${name}=`))
  ?.slice(name.length + 1)
check(field('cli') === 'yes', 'the runtime has a CLI to start', field('cli'))
check(field('nested') === 'no',
  'the tree is flat the way npm installs into a project, not nested as published', field('nested'))
// `ls node_modules | wc -l` counts top-level entries, so 200-ish is the real number for
// a ~830-package install: the rest live under the `@scope` directories.
check(Number(field('packages')) > 150, 'and it carries the full dependency set',
  `${String(field('packages'))} top-level entries`)
check(Number(field('size')) > 500, 'with the size a real install has', `${String(field('size'))} MiB`)

// The natives have to be the node's own platform, which is the whole reason the
// artefact is per-platform.
const natives = await nodeExec(
  `ls ${runtime}/node_modules | grep -E '^(sherpa-onnx|node-pty|sharp)' ; `
  + `ls ${runtime}/node_modules/@img 2>/dev/null | head -4`,
)
check(/sherpa-onnx-linux-x64/u.test(natives), 'native speech support is the Linux build',
  natives.trim().split('\n').slice(0, 3).join(','))
check(!/win-x64|darwin/u.test(natives), 'and no foreign-platform native came along',
  natives.trim().split('\n').slice(0, 3).join(','))
check(/sharp-linux-x64/u.test(natives), 'image support is the Linux build too')

// ---- the runtime actually starts -----------------------------------------
// `--version` is the cheapest thing that imports the real entry point; if a native
// module were missing or the wrong ABI this is where it fails.
const version_ = await nodeExec(`node ${cli} --version 2>&1 | tail -2`)
check(version_.trim() === version, 'the runtime runs and reports its version', version_.trim())
const helped = await nodeExec(`node ${cli} --help 2>&1 | head -3`)
check(helped.trim().length > 0 && !/Error|Cannot find/u.test(helped),
  'and its CLI resolves its own dependencies', helped.trim().split('\n')[0])

// ---- a second install is idempotent --------------------------------------
const again = await nodeExec(`sh -c '${script.replaceAll("'", `'\\''`)}'`, 900_000)
check(again.trim().split('\n').at(-1)?.includes(version),
  'a second install replaces the first cleanly', again.trim().split('\n').at(-1))
const previous = await nodeExec(`test -d ${runtime}.previous && echo kept || echo none`)
check(previous.trim() === 'kept', 'the replaced tree is kept for rollback', previous.trim())

// ---- rollback restores it ------------------------------------------------
const rolled = await nodeExec(`sh -c '${rollbackScript(runtime).replaceAll("'", `'\\''`)}'`)
check(rolled.trim().includes('rolled-back'), 'rollback reports what it did', rolled.trim())
const stillThere = await nodeExec(`test -f ${cli} && node ${cli} --version`)
check(stillThere.trim().includes(version), 'and the runtime still runs after it', stillThere.trim())

await nodeExec(`rm -rf ${root}`)
log(`cleaned ${root}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
