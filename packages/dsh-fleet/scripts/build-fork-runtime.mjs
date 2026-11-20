#!/usr/bin/env node
/**
 * Build the node runtime from **this project's fork** of the upstream DSH source.
 *
 * The fork lives outside this repository (`DSH_FORK_DIR`, default
 * `D:\ProjectHub\dsh-fork\deepseek-harness`): it is a clone of
 * `deepseek-ai/deepseek-harness` pinned to one release tag, carrying the local
 * patches this project needs. This script turns that checkout into the same
 * artefact a node consumes — `dsh-<version>-<platform>.tar.gz` plus its
 * `.sha256` — and then hands it to `publish-runtime.mjs` for upload, so there is
 * one publishing path and one archive contract regardless of who built the tree.
 *
 * ## Why build at all, when a node can resolve the release itself
 *
 * Because the fork exists to *change* the runtime, and a change to the runtime
 * only reaches a node through an archive built from that source. The npm fallback
 * route still installs the official release, which is the right answer for a node
 * that wants stock behaviour and the wrong one for a node that should run the
 * patched tree.
 *
 * ## What the tree loses on the way
 *
 * A node is a brain: it renders nothing. {@link trimForkRuntime} drops the browser
 * surface, the Office engine, the experimental bundles and the Electron shell
 * (measured 2014.6 MiB → 1185.8 MiB unpacked), then strips the same residue every
 * published artefact loses. What must stay is the `@deepseek-ai/dsh-web-app`
 * **manifest**: upstream resolves a profile's dependency closure through the
 * installation's manifests, and without it the brain's kept rows fail to load.
 *
 * ## Usage
 *
 * ```bash
 * # Everything: build the fork, pack it, resolve the tree for the target platform,
 * # trim it, and write the archive. Nothing is uploaded.
 * node packages/dsh-fleet/scripts/build-fork-runtime.mjs --platform linux-x64
 *
 * # Reuse a tree an earlier run left unpacked (iterating on the trim rules).
 * node packages/dsh-fleet/scripts/build-fork-runtime.mjs --platform linux-x64 --reuse
 *
 * # Publish what was built (GitHub release; add --cnb for the CNB primary source).
 * node packages/dsh-fleet/scripts/build-fork-runtime.mjs --platform linux-x64 --publish
 * ```
 *
 * The version comes from the fork's root manifest, so the archive cannot claim a
 * release the source is not on. It must equal the desktop's DSH version: the node
 * runs exactly what the desktop runs, and `decideGate` refuses anything else.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARTEFACT_RESIDUE, dropPackages, stripResidue } from './trim-fork-runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const fork = resolve(process.env.DSH_FORK_DIR ?? 'D:\\ProjectHub\\dsh-fork\\deepseek-harness')
const platform = value('platform', 'linux-x64')
const outDir = resolve(pluginRoot, value('out', '../../dist'))
const registry = value('registry', 'https://registry.npmmirror.com')
const reuse = flag('reuse')
const shouldPublish = flag('publish')
const shouldPublishCnb = flag('cnb')

/**
 * `linux-x64` → npm's `--os linux --cpu x64 --libc glibc`.
 *
 * The libc suffix is optional and Linux-only, exactly as in `publish-runtime.mjs`:
 * a musl node needs a musl tree, and `sharp` and `sherpa-onnx` publish one.
 */
function npmPlatform(tagName) {
  const [os, cpu, libc] = String(tagName).split('-')
  if (os === undefined || cpu === undefined) throw new Error(`--platform wants a tag like linux-x64, got "${tagName}"`)
  const flags = [`--os=${os}`, `--cpu=${cpu}`]
  if (os === 'linux') flags.push(`--libc=${libc ?? 'glibc'}`)
  else if (libc !== undefined) throw new Error(`only Linux splits by libc, and "${tagName}" is not Linux`)
  return flags
}

/** Run one command in the fork, failing with its own exit status. */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: fork,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${basename(command)} ${commandArgs.join(' ')} exited with ${String(result.status)}`)
  }
}

/**
 * The pnpm the fork pins, through corepack.
 *
 * The fork declares `packageManager: pnpm@11.28.5`; running whatever pnpm happens
 * to be on PATH would build with a different resolver than the lock file was made
 * by.
 */
function pnpm(scriptArgs) {
  run('corepack', [`pnpm@${forkPackageManagerVersion()}`, ...scriptArgs])
}

/** The exact pnpm version the fork pins. */
function forkPackageManagerVersion() {
  const manifest = JSON.parse(readFileSync(join(fork, 'package.json'), 'utf8'))
  const declared = String(manifest.packageManager ?? '')
  const match = /^pnpm@(.+)$/u.exec(declared)
  if (match === null) throw new Error(`${fork}/package.json pins no pnpm version (${JSON.stringify(declared)})`)
  return match[1]
}

/** The fork's own version, which is the release this archive is for. */
function forkVersion() {
  const manifest = JSON.parse(readFileSync(join(fork, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error(`${fork}/package.json has no version`)
  return manifest.version
}

/**
 * Whether one manifest field admits a platform value, following npm's own rule.
 *
 * `--os`/`--cpu` tell npm which platform to *resolve for*; they do not exempt a
 * direct `file:` dependency from its own `os` field. A staging manifest that
 * lists the darwin-only CUA helper for a linux target fails with `EBADPLATFORM`
 * before a single byte is installed, so foreign-platform packages are filtered
 * out here rather than handed to npm and hoped over.
 */
function accepts(value, current) {
  if (value === undefined || current === undefined) return true
  if (!Array.isArray(value)) throw new Error(`platform field must be an array, got ${JSON.stringify(value)}`)
  let accepted = value.every(tag => tag.startsWith('!'))
  for (const tag of value) {
    if (tag === `!${current}`) return false
    if (tag === current || (tag === 'any' && value.length === 1)) accepted = true
  }
  return accepted
}

/**
 * Write the staging manifest that turns packed tarballs into an installed tree.
 *
 * **The root depends on `@deepseek-ai/dsh` alone; every other packed package is an
 * `overrides` entry.** Listing all 384 tarballs as direct dependencies — which is
 * what `verify-packed-install` does — installs every package the fork *publishes*
 * rather than the closure the runtime *imports*: measured 1789.2 MiB unpacked
 * against 1144.5 MiB for the same trim rules. The difference is packages no
 * `dependencies` edge names (testkits, mocks, on-demand subagent bundles), and
 * shipping them is paying for bytes the node never loads.
 *
 * `overrides` is what makes the fork's bytes win without publishing to a
 * registry: the graph still says `0.2.2-rc.5`, and every edge to a package the
 * fork built resolves to that package's tarball instead of the registry's copy of
 * the same version. A package the fork did not build keeps resolving normally.
 *
 * Foreign-platform packages are skipped, so one staging directory can serve a
 * Linux target from a Windows host: `--os`/`--cpu` tell npm what to *resolve for*,
 * they do not exempt a direct `file:` dependency from its own `os` field.
 */
function stageManifest(staging) {
  const [os, cpu, libc] = platform.split('-')
  const target = { os, cpu, libc: os === 'linux' ? (libc ?? 'glibc') : undefined }
  const dirs = ['dist/npm', 'dist/npm-vendor', 'dist/npm-landlock']
  const packed = new Map()
  let skipped = 0
  for (const dir of dirs) {
    const absolute = join(fork, dir)
    if (!existsSync(absolute)) throw new Error(`${absolute} is missing; pack the fork before staging`)
    for (const file of readdirSync(absolute)) {
      if (!file.endsWith('.tgz')) continue
      const manifest = JSON.parse(tarRead(absolute, file, 'package/package.json'))
      const compatible = accepts(manifest.os, target.os)
        && accepts(manifest.cpu, target.cpu)
        && accepts(manifest.libc, target.libc)
      if (!compatible) { skipped += 1; continue }
      packed.set(manifest.name, `file:${join(absolute, file).replaceAll('\\', '/')}`)
    }
  }
  const entry = packed.get('@deepseek-ai/dsh')
  if (entry === undefined) throw new Error(`no @deepseek-ai/dsh tarball was packed for ${platform}`)
  const overrides = Object.fromEntries([...packed].filter(([name]) => name !== '@deepseek-ai/dsh'))
  writeFileSync(
    join(staging, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-fleet-fork-runtime',
      private: true,
      dependencies: { '@deepseek-ai/dsh': entry },
      overrides,
    }, undefined, 2)}\n`,
    'utf8',
  )
  return { count: packed.size, skipped }
}

/** Read one file out of a tarball. */
function tarRead(dir, file, member) {
  const result = spawnSync('tar', ['-xOzf', file, member], { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`tar could not read ${member} from ${file}`)
  return result.stdout
}

/** Build and pack the fork, unless an earlier run's output is being reused. */
function prepareFork() {
  if (reuse) {
    process.stdout.write('reusing the packed fork output already in dist/\n')
    return
  }
  process.stdout.write(`building ${fork}\n`)
  pnpm(['install', '--frozen-lockfile'])
  pnpm(['run', 'build:official'])
  pnpm(['run', 'release:pack', '--family', 'dsh', '--out', 'dist/npm', '--concurrency', '8'])
  // The harness packages declare the vendored framework as a peer, so the staging
  // manifest needs its tarballs too — the install must not depend on the registry
  // already carrying matching versions.
  pnpm(['run', 'release:pack', '--family', 'vendor', '--out', 'dist/npm-vendor', '--concurrency', '8'])
  pnpm(['--dir', 'native/system', 'run', 'build:ts'])
  pnpm(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(fork, 'dist', 'npm-landlock')])
}

/**
 * Resolve the packed fork for the target platform into an unpacked tree.
 *
 * `--ignore-scripts` is load-bearing for the same reason it is in
 * `publish-runtime.mjs`: an `install` script runs with **this** machine's
 * `process.platform`, so koffi would compile for the packer instead of the node.
 * Every native dependency in this tree ships a prebuilt platform package.
 */
function resolveTree(staging) {
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const count = stageManifest(staging)
  process.stdout.write(`installing ${String(count.count)} packed packages for ${platform}`
    + ` (${String(count.skipped)} foreign-platform skipped)\n`)
  const npm = process.platform === 'win32'
    // A Windows `.cmd` shim cannot be spawned without a shell; npm's own JS entry can.
    ? { command: process.execPath, args: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] }
    : { command: 'npm', args: [] }
  run(npm.command, [
    ...npm.args,
    'install',
    '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts',
    '--registry', registry,
    ...npmPlatform(platform),
  ], { cwd: staging })
}

/** Measure a tree. */
function measure(entry) {
  if (!existsSync(entry)) return { bytes: 0, files: 0 }
  const stat = statSync(entry)
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const child of readdirSync(entry, { withFileTypes: true })) {
    const inner = measure(join(entry, child.name))
    bytes += inner.bytes
    files += inner.files
  }
  return { bytes, files }
}

/**
 * Archive one trimmed tree and write its checksum.
 *
 * The archive's layout is the runtime directory itself — `node_modules/…` at the
 * top — because that is what `installScript` on the node unpacks into place.
 * Executable bits are restored before packing: `tar` on Windows writes
 * `-rw-rw-rw-` for every entry, and `installScript` repairs only the two
 * `spawn-helper` files it knows about.
 */
function archive(staging, version) {
  const name = `dsh-${version}-${platform}.tar.gz`
  const target = join(outDir, name)
  mkdirSync(outDir, { recursive: true })
  let modes = 0
  const restore = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { restore(full); continue }
      if (entry.name !== 'spawn-helper' && !entry.name.endsWith('.node')) continue
      try {
        chmodSync(full, 0o755)
        modes += 1
      } catch { /* the node repairs its own modes on unpack */ }
    }
  }
  restore(staging)
  rmSync(target, { force: true })
  const tarred = spawnSync('tar', ['-czf', target, '-C', staging, '.'], { stdio: 'inherit' })
  if (tarred.status !== 0) throw new Error(`tar exited with ${String(tarred.status)}`)
  const bytes = readFileSync(target)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(`${target}.sha256`, `${sha256}  ${name}\n`, 'utf8')
  const tree = measure(staging)
  const mib = value => (value / 1048576).toFixed(1)
  process.stdout.write(
    `wrote ${name}\n`
    + `  archive  ${mib(bytes.length)} MiB\n`
    + `  unpacked ${String(tree.files)} files, ${mib(tree.bytes)} MiB\n`
    + `  modes    ${String(modes)} files marked 0755\n`
    + `  sha256   ${sha256}\n`,
  )
  return { name, target, sha256 }
}

/**
 * Refuse to build an archive whose version a node would then reject.
 *
 * A node runs **exactly** the desktop's DSH version (`decideGate` in
 * `src/core/version.js`). Building the fork on a tag the desktop is not on
 * produces an archive no node can install, and the failure would surface on a
 * node rather than here.
 *
 * `DSH_INSTALL_DIR` points **inside `app.asar`** on a packaged desktop, which
 * plain Node cannot read. That is not a reason to fail: the check degrades to a
 * warning, because the version is also the fork's own and a mismatched tag shows
 * up as a refused connection on the first node that tries it.
 */
function checkAgainstDesktop(version) {
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir !== 'string' || installDir === '') {
    process.stdout.write('DSH_INSTALL_DIR is not set; skipping the desktop version check\n')
    return
  }
  let desktop
  try {
    desktop = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version
  } catch (error) {
    process.stdout.write(
      `could not read the desktop's DSH version (${String(error.code ?? error.message)}); `
      + 'skipping the check — run this with the desktop\'s own Node to enable it:\n'
      + '  ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" packages/dsh-fleet/scripts/build-fork-runtime.mjs …\n',
    )
    return
  }
  if (desktop !== version) {
    throw new Error(
      `the fork is on ${version} but this desktop runs ${desktop}; a node must run the desktop's `
      + `release exactly, so check out dsh-v${desktop} in ${fork} first`,
    )
  }
}

const version = forkVersion()
checkAgainstDesktop(version)
prepareFork()

const staging = join(fork, 'stage', platform)
if (!reuse || !existsSync(join(staging, 'node_modules'))) resolveTree(staging)

const before = measure(join(staging, 'node_modules'))
const dropped = dropPackages(staging)
const stripped = stripResidue(staging, ARTEFACT_RESIDUE)
const after = measure(join(staging, 'node_modules'))
const mib = value => (value / 1048576).toFixed(1)
process.stdout.write(
  `trimmed ${mib(before.bytes)} MiB → ${mib(after.bytes)} MiB unpacked`
  + ` (${String(dropped.dropped.length)} packages, ${mib(dropped.bytes + stripped.bytes)} MiB removed)\n`,
)

const built = archive(staging, version)

if (!shouldPublish && !shouldPublishCnb) {
  process.stdout.write(
    '\nNot published. Upload with:\n'
    + `  node packages/dsh-fleet/scripts/build-fork-runtime.mjs --platform ${platform} --reuse --publish\n`,
  )
  process.exit(0)
}

// Publication is the same script the upstream artefact route uses, so both kinds
// of archive reach a node through one set of sources and one checksum contract.
const publish = spawnSync(process.execPath, [
  join(here, 'publish-runtime.mjs'),
  '--platform', platform,
  '--version', version,
  '--out', outDir,
  '--cnb-only',
  ...(shouldPublish ? ['--publish'] : []),
  ...(shouldPublishCnb ? ['--cnb'] : []),
], { stdio: 'inherit' })
if (publish.status !== 0) throw new Error(`publishing ${built.name} failed with ${String(publish.status)}`)
