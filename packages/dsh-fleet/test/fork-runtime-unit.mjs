/**
 * The fork-runtime build: which packages a brain tree keeps, and what it refuses to
 * hand to npm.
 *
 * Two rules from that script decide whether a node can boot at all, and both were
 * measured rather than guessed, so both get an assertion:
 *
 * 1. **`@deepseek-ai/dsh-web-app` is retained even though the brain never loads it.**
 *    Upstream resolves a profile's dependency closure through the installation's
 *    manifests. Dropping that one manifest made the loader fail on fifteen kept rows
 *    with `ERR_MODULE_NOT_FOUND` — the rows themselves never import the package.
 * 2. **Foreign-platform packages are filtered before npm sees them.** `--os`/`--cpu`
 *    choose what to resolve *for*; they do not exempt a direct `file:` dependency
 *    from its own `os` field, so a darwin-only tarball in the staging manifest fails
 *    the whole install with `EBADPLATFORM`.
 *
 * The rest of the trim is a removal list, and its risk is the opposite one: removing
 * something a kept row imports. That cannot be checked from the script alone — it is
 * checked by booting the built tree, which `docs/ARCHITECTURE.md` records as the
 * acceptance evidence for this path.
 *
 * Run: `node test/fork-runtime-unit.mjs`
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARTEFACT_RESIDUE,
  DROP_RULES,
  RETAINED,
  dropPackages,
  stripResidue,
} from '../scripts/trim-fork-runtime.mjs'

const log = message => process.stdout.write(`[fork-runtime-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** One package directory with a manifest, so the trim has something to weigh. */
function packageIn(root, name) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export {}\n', 'utf8')
  return dir
}

// ---- what the trim must keep, and why ---------------------------------------
{
  // The one entry that looks like a mistake and is not: without this manifest the
  // brain's own kept rows cannot resolve their dependencies.
  check(RETAINED.includes('@deepseek-ai/dsh-web-app'), 'the web-app manifest is retained')
  check(RETAINED.includes('@deepseek-ai/dsh-office-kit'), 'the office host row keeps its kit')
  // A retained name must not also match a drop rule, or the two lists contradict
  // each other and the result depends on which one the loop reaches first.
  const contradictions = RETAINED.filter(name => DROP_RULES.some(([pattern]) => pattern.test(name.slice('@deepseek-ai/'.length))))
  check(contradictions.length === 0, 'no retained package matches a drop rule', contradictions.join(', '))
  // Every rule states why; a rule without a reason is a guess with a regex.
  check(DROP_RULES.every(([, reason]) => typeof reason === 'string' && reason.length > 10),
    'every drop rule states its reason')
}

// ---- the trim itself --------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'fork-trim-'))
  try {
    packageIn(root, '@deepseek-ai/dsh')
    packageIn(root, '@deepseek-ai/dsh-web-app')
    packageIn(root, '@deepseek-ai/dsh-office-kit')
    packageIn(root, '@deepseek-ai/dsh-client-ui-chat')
    packageIn(root, '@deepseek-ai/dsh-experimental-inspector')
    packageIn(root, '@deepseek-ai/libreoffice-kit-win32-x64')
    packageIn(root, '@deepseek-ai/dsh-cua-bundle')
    packageIn(root, '@deepseek-ai/dsh-unclassified-new-package')
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'index.d.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'index.js.map'), '{}', 'utf8')
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'README.md'), '# dsh\n', 'utf8')
    mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'test'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'test', 'a.js'), 'export {}\n', 'utf8')

    const result = dropPackages(root)
    const scope = join(root, 'node_modules', '@deepseek-ai')
    const left = name => {
      try {
        readFileSync(join(scope, name, 'package.json'))
        return true
      } catch {
        return false
      }
    }
    check(left('dsh') && left('dsh-web-app') && left('dsh-office-kit'),
      'a package nothing drops is kept')
    check(left('dsh-unclassified-new-package'),
      'a package with no matching rule is kept rather than guessed at')
    check(!left('dsh-client-ui-chat'), 'the browser surface is dropped')
    check(!left('dsh-experimental-inspector'), 'experimental bundles are dropped')
    check(!left('libreoffice-kit-win32-x64'), 'the Office engine is dropped')
    check(!left('dsh-cua-bundle'), 'computer use is dropped')
    check(result.dropped.length === 4, 'every drop is reported', String(result.dropped.length))

    const stripped = stripResidue(root, ARTEFACT_RESIDUE)
    check(stripped.files === 4, 'declarations, maps, readmes and tests are stripped', String(stripped.files))
    const kept = readFileSync(join(scope, 'dsh', 'index.js'), 'utf8')
    check(kept.includes('export'), 'the runtime file survives the strip')
    // `doc/` must never be a strip rule: `yaml` ships code under `dist/doc/`.
    check(!ARTEFACT_RESIDUE.some(pattern => pattern.test('node_modules/yaml/dist/doc/directives.js')),
      'the strip never matches a package path named doc/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- the archive contract ---------------------------------------------------
{
  // The residue list has one home. Two copies would drift into two artefact
  // contents at one version, which is what `RUNTIME_BUILD` exists to catch.
  const publish = readFileSync(new URL('../scripts/publish-runtime.mjs', import.meta.url), 'utf8')
  check(/import \{ ARTEFACT_RESIDUE \}/u.test(publish),
    'publish-runtime strips with the shared residue list')
  check(!/const STRIPPED = Object\.freeze/u.test(publish),
    'and keeps no second copy of it')
  const build = readFileSync(new URL('../scripts/build-fork-runtime.mjs', import.meta.url), 'utf8')
  check(/ARTEFACT_RESIDUE/u.test(build), 'the fork build strips with the same list')
  check(/--ignore-scripts/u.test(build), 'the fork build resolves without running install scripts')
  check(/overrides/u.test(build),
    'the fork build stages by override, so only the imported closure is installed')
  check(/publish-runtime\.mjs/u.test(build), 'the fork build publishes through the one uploader')
  // One uploader means one source list: a fork archive must reach a node through
  // `DEFAULT_SOURCES`, or the node would need a second, undocumented route.
  check(!/DEFAULT_SOURCES|cnb\.cool/u.test(build),
    'and does not invent a second download source')
  // The staging manifests name 384 tarballs by absolute path on the packing machine, so
  // shipping them would publish the packer's filesystem layout — and leave a manifest on the
  // node that a later `npm install` there could act on. Measured on the first build-4 archives:
  // they carried `package.json`, `package-lock.json` and `node_modules/.package-lock.json`.
  check(/package-lock\.json/u.test(build) && /rmSync\(join\(staging, scratch\)/u.test(build),
    'the fork build removes its staging manifests before packing')
}

if (failures.length > 0) {
  log(`${failures.length} failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all assertions passed')
}
