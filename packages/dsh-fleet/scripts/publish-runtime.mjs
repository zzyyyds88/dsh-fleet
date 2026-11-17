#!/usr/bin/env node
/**
 * Publish the node runtime a desktop release was tested against.
 *
 * A node used to get its DSH by running `npm install` over SSH: several minutes, a
 * working registry, and a tree nobody could reproduce. This is the artefact route
 * instead — the desktop publishes the exact runtime a node should run, and every node
 * downloads that tarball.
 *
 * **Why this does not simply pack the local installation.** A DSH install is not pure
 * JavaScript: `node-pty`, `sharp` and `sherpa-onnx` ship native binaries, and the
 * installed tree names the platform it was built for (`sherpa-onnx-win-x64`,
 * `@img/sharp-linux-x64`/`sharp-libvips-linux-x64`). Packing this Windows desktop's tree
 * and unpacking it on a Linux node would give a node whose terminal and image tools fail
 * at first use — worse than the slow install it replaced, because it fails later and
 * further from the cause.
 *
 * So the tree is resolved **for the target platform** by npm's own platform flags
 * (`--os --cpu --libc`), from the same version the desktop runs. That keeps the two
 * properties that matter — same release, correct natives — and drops the one that never
 * held (same bytes).
 *
 * Usage:
 *   node packages/dsh-fleet/scripts/publish-runtime.mjs [--platform linux-x64] [--out dist] [--publish]
 *
 * `--platform` accepts the tag form the plugin uses (`linux-x64`, `linux-arm64`,
 * `darwin-arm64`). Nothing is published unless `--publish` is given.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const platform = value('platform', 'linux-x64')
const outDir = resolve(pluginRoot, value('out', '../../dist'))
const shouldPublish = flag('publish')
const tag = value('tag', undefined)
const registry = value('registry', 'https://registry.npmmirror.com')

/** `linux-x64` → npm's `--os linux --cpu x64`, plus libc for the Linux split. */
function npmPlatform(tagName) {
  const [os, cpu] = tagName.split('-')
  if (!os || !cpu) throw new Error(`--platform wants a tag like linux-x64, got "${tagName}"`)
  const flags = [`--os=${os}`, `--cpu=${cpu}`]
  // sharp and sherpa-onnx publish glibc and musl variants; glibc is the default these
  // nodes run, and being explicit stops npm from picking the host's answer.
  if (os === 'linux') flags.push('--libc=glibc')
  return flags
}

/**
 * The version to publish.
 *
 * Taken from the installation the desktop actually runs, so `publish` cannot disagree
 * with the app that will ask nodes for it.
 */
function installedVersion() {
  const fromEnv = process.env.DSH_INSTALL_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && existsSync(join(fromEnv, 'package.json'))) {
    return JSON.parse(readFileSync(join(fromEnv, 'package.json'), 'utf8')).version
  }
  const fromArg = value('version', undefined)
  if (typeof fromArg === 'string' && fromArg.length > 0) return fromArg
  throw new Error(
    'Set DSH_INSTALL_DIR (as the desktop app does) or pass --version. '
    + 'Running this with the desktop\'s own Node sets it: '
    + 'ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" scripts/publish-runtime.mjs',
  )
}

/**
 * Files a running node never reads.
 *
 * Type declarations, source maps, package docs and per-package test trees are roughly a
 * third of an install and none of it is loaded by `node lib/bin.js`. `LICENSE` files are
 * kept: they are the licence conditions of the packages being redistributed.
 *
 * **No pattern here may match a directory whose name merely looks like documentation.**
 * `/(^|\/)docs?\//` was in this list and broke the node outright: `yaml` ships
 * `dist/doc/directives.js`, which `dist/compose/composer.js` requires, so stripping
 * `doc/` removed a module the runtime loads during boot. A `doc`-shaped directory inside
 * a package's build output is code, not documentation, and nothing distinguishes the two
 * from the path alone — so the rule is gone rather than narrowed. Measured cost of
 * keeping those trees: under 2 MB.
 */
const STRIPPED = Object.freeze([
  /\.d\.ts$/u,
  /\.d\.mts$/u,
  /\.map$/u,
  /(^|\/)README(\.[^/]*)?$/iu,
  /(^|\/)CHANGELOG(\.[^/]*)?$/iu,
  /(^|\/)\.github\//u,
  /(^|\/)(test|tests|__tests__)\//u,
  /(^|\/)\.md$/iu,
])

function measure(dir) {
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = measure(full)
      bytes += inner.bytes
      files += inner.files
      continue
    }
    files += 1
    try { bytes += statSync(full).size } catch { /* vanished mid-walk */ }
  }
  return { bytes, files }
}

/** Delete everything `STRIPPED` matches, depth first. */
function strip(dir, base = dir) {
  let removed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const relative = full.slice(base.length).replaceAll('\\', '/')
    // A directory is matched with a trailing slash so a file-shaped pattern (`.md`)
    // cannot take a whole tree with it, and a directory-shaped one (`test/`) cannot
    // match an unrelated file.
    const subject = entry.isDirectory() ? `${relative}/` : relative
    if (STRIPPED.some(pattern => pattern.test(subject))) {
      removed += entry.isDirectory() ? measure(full).bytes : (statSync(full).size ?? 0)
      rmSync(full, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) removed += strip(full, base)
  }
  return removed
}

const version = installedVersion()
const name = `dsh-${version}-${platform}.tar.gz`
const staging = join(outDir, `.staging-${version}-${platform}`)
const runtime = join(staging, 'node_modules')

mkdirSync(outDir, { recursive: true })
rmSync(staging, { recursive: true, force: true })
mkdirSync(runtime, { recursive: true })

// A minimal manifest so npm installs a *tree* rather than resolving a project.
writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
  name: 'dsh-fleet-runtime',
  private: true,
  dependencies: { '@deepseek-ai/dsh': version },
}, undefined, 2)}\n`, 'utf8')

process.stdout.write(`resolving @deepseek-ai/dsh ${version} for ${platform}\n`)
const install = spawnSync('npm', [
  'install',
  '--prefix', staging,
  '--no-audit', '--no-fund', '--loglevel=error',
  '--registry', registry,
  ...npmPlatform(platform),
], { stdio: 'inherit', shell: process.platform === 'win32' })
if (install.status !== 0) throw new Error(`npm install failed with status ${String(install.status)}`)

const cli = join(runtime, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(cli)) throw new Error(`the resolved tree has no ${cli}; refusing to publish it`)

// The lock file and npm's own metadata describe a *project*, not the runtime a node
// starts. Keeping them would let a later `npm install` on the node rewrite the tree.
for (const scratch of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json']) {
  rmSync(join(staging, scratch), { force: true })
}

const before = measure(staging)
const stripped = strip(staging)
const after = measure(staging)

const archive = join(outDir, name)
rmSync(archive, { force: true })
// A subprocess rather than a library: `tar` is on every platform this ships to, and
// this script must not add a dependency to the plugin.
const tarred = spawnSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' })
if (tarred.status !== 0) throw new Error(`tar failed with status ${String(tarred.status)}`)
rmSync(staging, { recursive: true, force: true })

const bytes = readFileSync(archive)
const sha256 = createHash('sha256').update(bytes).digest('hex')
writeFileSync(`${archive}.sha256`, `${sha256}  ${name}\n`, 'utf8')

const mib = value => (value / 1024 / 1024).toFixed(1)
process.stdout.write(
  `wrote ${name}\n`
  + `  archive  ${mib(bytes.length)} MiB\n`
  + `  unpacked ${after.files} files, ${mib(after.bytes)} MiB`
  + ` (${mib(stripped)} MiB stripped from ${before.files})\n`
  + `  sha256   ${sha256}\n`,
)

if (!shouldPublish) {
  process.stdout.write(
    '\nNot published. Upload with:\n'
    + `  gh release upload ${tag ?? `v${version}`} "${archive}" "${archive}.sha256" --clobber\n`,
  )
  process.exit(0)
}

const releaseTag = tag ?? `v${version}`
const notes = [
  `Node runtime for DSH ${version} on ${platform}.`,
  '',
  'A node downloads this instead of running an npm install:',
  '`~/.dsh-fleet/runtime` becomes exactly this tree.',
  '',
  `sha256: ${sha256}`,
].join('\n')
const made = spawnSync('gh', [
  'release', 'create', releaseTag,
  '--title', `DSH ${version} node runtime`,
  '--notes', notes,
], { stdio: 'inherit' })
// A pre-existing release is the normal case after publishing a second platform; a
// failed *upload* is the one that must stop this script.
if (made.status !== 0) process.stdout.write(`release ${releaseTag} already exists; uploading into it\n`)
const uploaded = spawnSync('gh', [
  'release', 'upload', releaseTag, archive, `${archive}.sha256`, '--clobber',
], { stdio: 'inherit' })
if (uploaded.status !== 0) throw new Error('the release upload failed')
process.stdout.write(`published ${name} to ${releaseTag}\n`)
