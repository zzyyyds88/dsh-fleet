/**
 * The manifest `plugin_manager install_bundle` reads, checked against the tree it ships.
 *
 * Every assertion here corresponds to a failure that is silent at install time:
 *
 *   - a `dsh.bundle.patch` naming a file that is not in the package makes the bundle
 *     load with *fewer* rows than intended — the profile reports it as skipped, and the
 *     only visible symptom is a feature that simply never appears;
 *   - `files` that omits a runtime directory ships a package that resolves on the
 *     developer's machine (the source is right there) and fails on a fresh install;
 *   - `locale.*.meta.detail` pointing at a path that does not exist renders an empty
 *     detail page, which no test can notice from the outside;
 *   - an unparsable `engines.dsh` range turns every install into a compatibility warning
 *     nobody can act on.
 *
 * Runs with plain Node: it reads this package's own files, nothing from the install.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let failed = 0
const checks = []
function ok(condition, message, detail) {
  checks.push({ condition, message })
  if (!condition) failed += 1
  const mark = condition ? 'ok  ' : 'FAIL'
  console.log(`[install] ${mark} ${message}${detail === undefined ? '' : ` — ${detail}`}`)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ---- identity -------------------------------------------------------------

ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'the package has a name', manifest.name)
ok(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(manifest.version), 'the version is a real semver', manifest.version)
// Published now, so the fields a registry page reads have to be there. `private` is the
// one that matters most: it makes `npm publish` refuse outright.
ok(manifest.private !== true, 'the package is publishable: `private` would make npm publish refuse',
  String(manifest.private))
ok(manifest.license === 'MIT', 'it declares the licence the README and LICENSE file state', String(manifest.license))
for (const field of ['repository', 'homepage', 'bugs', 'author', 'keywords']) {
  ok(manifest[field] !== undefined, `${field} is declared, so the registry page links back here`, JSON.stringify(manifest[field]))
}
ok(manifest.repository?.url?.includes('github.com/zzyyyds88/dsh-fleet'),
  'the repository field names this repository', String(manifest.repository?.url))
ok(manifest.publishConfig?.access === 'public',
  'a scoped package defaults to restricted; access must be published explicitly',
  JSON.stringify(manifest.publishConfig))
// The name has to be one npm can actually accept from this account. Two names were tried and
// both are blocked: `@local` is another organisation's scope, and the plain `dsh-fleet` was
// taken. `@greatbaby` is the publishing account's own scope, which needs no organisation and
// cannot be claimed by anyone else.
ok(manifest.name === '@greatbaby/dsh-fleet',
  'the name is inside the publishing account own scope', manifest.name)
ok(manifest.name === (readFileSync(join(root, 'src', 'client', 'client.js'), 'utf8')
  .match(/id: '([^']+)',/u)?.[1] ?? ''),
  'the client plugin id equals the package name, as DSH requires',
  manifest.name)

// ---- dsh.bundle.patch -----------------------------------------------------

const patchDeclaration = manifest.dsh?.bundle?.patch
const patchFiles = typeof patchDeclaration === 'string'
  ? [patchDeclaration]
  : Array.isArray(patchDeclaration) ? patchDeclaration : undefined
ok(patchFiles !== undefined && patchFiles.length > 0, 'dsh.bundle.patch is a path or a list of paths', JSON.stringify(patchDeclaration))
for (const file of patchFiles ?? []) {
  ok(typeof file === 'string' && file.startsWith('./'), `${String(file)} is a relative path inside the package`)
  ok(existsSync(join(root, file)), `${file} exists in the source tree`)
  // The launcher concatenates the layers in declaration order, so the plugin's own row
  // has to come before any preset that depends on a tool it registers.
  const text = existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : ''
  ok(text.includes('insert:'), `${file} carries insert entries`)
}

const ownPatch = join(root, 'cordis.patch.yml')
ok(existsSync(ownPatch) && readFileSync(ownPatch, 'utf8').includes("- id: dsh-fleet"), 'the plugin row is still declared in cordis.patch.yml')

// ---- engines.dsh ----------------------------------------------------------

const range = manifest.engines?.dsh
ok(typeof range === 'string' && range.trim().length > 0, 'engines.dsh is declared, so this bundle alone decides its compatibility', range)
if (typeof range === 'string') {
  const tokens = range.trim().split(/\s+/u)
  const legs = tokens.length % 2 === 0 ? tokens.length / 2 : tokens.length
  const comparator = /^(?:>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+(?:-[\w.]+)?$/u
  ok(tokens.length % 2 === 0 || tokens.length === 1, 'a compound range has a comparator per version', range)
  ok(tokens.every(token => token === '||' || comparator.test(token)), 'every comparator is one npm understands', range)
  ok(legs >= 1, 'the range names at least one version', range)
  // The one shipped DSH is a release candidate; a range that cannot express a prerelease
  // would silently exclude the very installation this plugin is tested against.
  ok(!range.includes('*'), 'the range is bounded rather than open', range)
}

// ---- exports and what they point at ---------------------------------------

const exportsMap = manifest.exports ?? {}
ok(exportsMap['.'] !== undefined, 'the Host half is exported')
ok(exportsMap['./client'] !== undefined, 'the client half is exported')
ok(exportsMap['./icon'] !== undefined, 'the icon is exported: the settings card reads it through this specifier')
ok(exportsMap['./locale/*.json'] !== undefined, 'locale dictionaries are exported')
for (const [key, value] of Object.entries(exportsMap)) {
  const target = typeof value === 'string' ? value : undefined
  if (target === undefined || target.includes('*')) continue
  ok(existsSync(join(root, target)), `exports["${key}"] points at a real file`, target)
}
// The node-control tool ships as its own entry point so the preset can mount it alone;
// an entry that is not exported cannot be named by a patch row.
ok(exportsMap['./node-control'] !== undefined, 'the node-control tool has its own entry point')
if (typeof exportsMap['./node-control'] === 'string') {
  ok(existsSync(join(root, exportsMap['./node-control'])), 'and that entry point exists', exportsMap['./node-control'])
}

// ---- files: everything the Host will load at run time ----------------------

const files = Array.isArray(manifest.files) ? manifest.files : undefined
ok(files !== undefined && files.length > 0, 'files is an allowlist, so a fresh install ships exactly what was chosen')
const listed = entry => (files ?? []).some(pattern => {
  const prefix = pattern.replace(/\/\*.*$/u, '').replace(/\/$/u, '')
  return pattern === entry || (prefix.length > 0 && (entry === prefix || entry.startsWith(`${prefix}/`)))
})
for (const required of ['src', 'locale', 'docs', 'icon.svg', 'README.md', 'cordis.patch.yml', 'presets']) {
  const present = existsSync(join(root, required))
  ok(present, `${required} exists in the source tree`)
  if (present) ok(listed(required), `${required} is covered by files`)
}
// `docs` covers the detail page, but the page the locale names has to be inside it.
for (const localeName of ['zh', 'en']) {
  const localeFile = join(root, 'locale', `${localeName}.json`)
  if (!existsSync(localeFile)) { ok(false, `locale/${localeName}.json exists`); continue }
  const locale = JSON.parse(readFileSync(localeFile, 'utf8'))
  const detail = locale.meta?.detail
  ok(typeof detail === 'string', `locale/${localeName}.json names a detail page`, detail)
  if (typeof detail === 'string') {
    ok(existsSync(join(root, detail)), `the detail page locale/${localeName}.json names exists`, detail)
    ok(listed(detail), 'and it is inside the packaged files', detail)
  }
  ok(typeof locale.meta?.title === 'string' && locale.meta.title.length > 0, `locale/${localeName}.json has a title`)
  ok(typeof locale.meta?.description === 'string' && locale.meta.description.length > 0, `locale/${localeName}.json has a description`)
}

// A detail page is a picture and a sentence: a Markdown link to an SVG that is not there
// renders as a broken image in the settings card.
for (const detailName of ['DETAIL.md', 'DETAIL.zh.md']) {
  const file = join(root, 'docs', detailName)
  if (!existsSync(file)) { ok(false, `docs/${detailName} exists`); continue }
  const text = readFileSync(file, 'utf8')
  const image = /!\[[^\]]*\]\(([^)]+)\)/u.exec(text)
  ok(image !== null, `docs/${detailName} embeds a preview image`)
  if (image !== null) ok(existsSync(join(root, 'docs', image[1])), `the image docs/${detailName} names exists`, image[1])
}

const previewPath = join(root, 'docs', 'preview.svg')
if (existsSync(previewPath)) {
  const svg = readFileSync(previewPath, 'utf8')
  ok(svg.startsWith('<svg') || svg.includes('<svg'), 'docs/preview.svg is an SVG document')
  ok(statSync(previewPath).size < 256 * 1024, 'the preview stays under the 256 KiB the settings card accepts', `${String(Math.round(statSync(previewPath).size / 1024))} KiB`)
}

// ---- the client entry the Host serves -------------------------------------

const clientEntry = typeof exportsMap['./client'] === 'string' ? exportsMap['./client'] : undefined
if (clientEntry !== undefined && existsSync(join(root, clientEntry))) {
  const client = readFileSync(join(root, clientEntry), 'utf8')
  ok(client.length > 0, 'the client entry is not empty')
  ok(!client.includes("@deepseek-ai/"), 'the client half imports nothing from the product: it reaches the Host through the plugin\'s own API')
}

// ---- presets --------------------------------------------------------------

const presetDir = join(root, 'presets')
if (existsSync(presetDir)) {
  const presets = readdirSync(presetDir).filter(name => name.endsWith('.patch.yml'))
  ok(presets.length > 0, 'the node-control preset ships with the plugin')
  for (const preset of presets) {
    const declared = (patchFiles ?? []).some(file => file.endsWith(`presets/${preset}`))
    ok(declared, `presets/${preset} is declared in dsh.bundle.patch: an undeclared preset is never loaded`)
  }
  for (const file of patchFiles ?? []) {
    if (!file.includes('presets/')) continue
    const name = relative(join(root, 'presets'), join(root, file))
    ok(presets.includes(name), `${file} exists on disk`, name)
  }
}

// A preset row names the plugin's own tool entry; a typo there mounts nothing and the
// agent silently has no tools at all.
for (const preset of existsSync(presetDir) ? readdirSync(presetDir).filter(n => n.endsWith('.patch.yml')) : []) {
  const text = readFileSync(join(presetDir, preset), 'utf8')
  for (const line of text.split('\n')) {
    const match = /^\s*name:\s*'@local\/dsh-fleet(\/[^']*)?'/u.exec(line)
    if (match === null) continue
    const subpath = match[1]
    ok(subpath === undefined || exportsMap[`.${subpath}`] !== undefined, `${preset} names an exported entry point`, subpath ?? '<root>')
  }
}

// ---- nothing personal ships ----------------------------------------------

// The repository is public. A test node's address, or a password, in a shipped file is a
// leak that survives every other check.
const FORBIDDEN = [
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u, 'a literal IPv4 address'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, 'a private key'],
]
const scanned = []
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (!/\.(?:js|mjs|json|yml|yaml|md|svg)$/u.test(entry.name)) continue
    scanned.push(full)
  }
}
for (const directory of ['src', 'locale', 'docs', 'presets']) {
  if (existsSync(join(root, directory))) walk(join(root, directory))
}
for (const file of ['README.md', 'cordis.patch.yml', 'package.json']) {
  if (existsSync(join(root, file))) scanned.push(join(root, file))
}
for (const file of scanned) {
  const text = readFileSync(file, 'utf8')
  for (const [pattern, description] of FORBIDDEN) {
    // `192.0.2.x` / `127.0.0.1` are documentation addresses, not a deployment.
    const hits = (text.match(new RegExp(pattern.source, 'gu')) ?? [])
      .filter(hit => !/^(?:127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/u.test(hit))
    ok(hits.length === 0, `${relative(root, file).split(sep).join('/')} contains no ${description}`, hits.slice(0, 3).join(', '))
  }
}

console.log('')
if (failed > 0) {
  console.error(`[install] ${failed} of ${checks.length} checks failed`)
  process.exitCode = 1
} else {
  console.log(`[install] all ${checks.length} checks passed`)
}
