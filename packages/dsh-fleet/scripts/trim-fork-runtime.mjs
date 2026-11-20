/**
 * Drop the parts of a forked DSH runtime a node never loads.
 *
 * The node is a **brain**: it composes `@deepseek-ai/dsh-base` plus
 * `@local/dsh-fleet-brain` and serves the Remote API. It renders nothing, so the
 * browser surface and every package that exists only to draw a window are dead
 * weight — and the node pays for them in download time and disk on every machine.
 *
 * Measured on the rc.5 tree, before → after (unpacked):
 *
 * | | before | after |
 * |---|---|---|
 * | whole tree | 2014.6 MiB | 1185.8 MiB |
 * | `dsh-client-ui-*` | 78.8 MiB / 65 packages | 0 |
 * | `dsh-web-frontend` | 20.1 MiB | 0 |
 * | `libreoffice-kit*` | 339.5 MiB | 0 |
 * | `dsh-experimental-*` | 111.3 MiB / 41 packages | 0 |
 *
 * ## `@deepseek-ai/dsh-web-app` stays, and that is not an oversight
 *
 * Upstream resolves a profile bundle's dependency closure by walking the
 * manifests of the installation's own dependency tree (`collectInstallationScopePackages`
 * in `dsh-app-boot`). The brain's patch keeps the Web host-plane rows, and those
 * rows name packages (`dsh-client-ui-*` among them) that only the `web-app`
 * manifest declares. Removing that manifest made the loader fail on fifteen rows
 * with `ERR_MODULE_NOT_FOUND`, even though the rows the brain keeps never import
 * them. Keeping one 0.2 MiB manifest is what lets the trimmed tree boot.
 *
 * ## What may be dropped, and the one rule behind it
 *
 * Nothing a kept row *imports* may go. Everything else is fair game, so the two
 * lists below are read together:
 *
 * - {@link RETAINED} names what must survive because a kept row loads it.
 * - {@link DROP_RULES} names what goes, each with the reason it cannot be reached.
 *
 * A package that is in neither list stays: this module removes what it can prove
 * is unreachable, never what it merely suspects.
 *
 * ## Why this is not `STRIPPED` in `publish-runtime.mjs`
 *
 * They answer different questions. `STRIPPED` removes *files* from any runtime,
 * upstream or fork, and is part of the published artefact's contract
 * (`RUNTIME_BUILD`). These rules remove *packages*, which only makes sense for a
 * tree this project compiled itself — an upstream install has to keep them
 * because upstream's own bundles may name them.
 *
 * @module @greatbaby/dsh-fleet/scripts/trim-fork-runtime
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

/**
 * Build residue no runtime reads: type declarations, source maps, package docs
 * and per-package test trees. Kept here rather than in `publish-runtime.mjs` so
 * the fork build and the upstream artefact build strip exactly the same files —
 * they produce archives a node consumes identically, and a divergence between
 * them would be a difference in the artefact's contents at one version.
 *
 * `doc/` is deliberately absent: `yaml` ships `dist/doc/directives.js`, which is
 * code, and a path cannot tell the two apart (measured — a `docs?/` rule removed
 * it and every node installed from that artefact failed with `MODULE_NOT_FOUND`).
 * @type {ReadonlyArray<RegExp>}
 */
export const ARTEFACT_RESIDUE = Object.freeze([
  /\.d\.ts$/u,
  /\.d\.mts$/u,
  /\.map$/u,
  /(^|\/)README(\.[^/]*)?$/iu,
  /(^|\/)CHANGELOG(\.[^/]*)?$/iu,
  /(^|\/)\.github\//u,
  /(^|\/)(test|tests|__tests__)\//u,
  /(^|\/)\.md$/iu,
])

/** Packages a kept host-plane row imports at runtime, so they survive the trim. */
export const RETAINED = Object.freeze([
  // The manifest that declares the dependency closure the brain's kept rows need.
  '@deepseek-ai/dsh-web-app',
  // Office host rows the brain composition keeps.
  '@deepseek-ai/dsh-office-kit',
  '@deepseek-ai/dsh-skill-office',
  '@deepseek-ai/dsh-tool-office',
])

/**
 * Removal rules, applied to the `@deepseek-ai` scope by package name.
 *
 * Each entry says why nothing the brain keeps can reach that package. A rule that
 * cannot state its reason is not a rule; it is a guess with a regular expression.
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
export const DROP_RULES = Object.freeze([
  [/^dsh-client-ui-/u, 'a browser window this node does not have'],
  [/^dsh-web-frontend$/u, 'the SPA dist the brain never serves'],
  [/^libreoffice-kit/u, 'document conversion the node never runs; the win32 engine alone is 189.7 MiB'],
  [/^dsh-experimental-/u, 'evaluated capabilities with no product commitment; none is a row in the brain composition'],
  [/^dsh-cua(?:-|$)/u, 'computer use: needs a screen on the node'],
  [/^dsh-browser-use$/u, 'browser automation: needs a browser on the node'],
  [/^dsh-client-test-runtime$/u, 'a test harness'],
  [/^dsh-desktop(?:-|$)/u, 'the Electron shell'],
  [/^dsh-subagent-(?:claude-code|codex|acp|dsh-sdk)$/u, 'on-demand subagent bundles the node never installs'],
  [/^dsh-hooks-(?:claude-code|codex)$/u, 'editor hooks for a developer machine'],
  [/^dsh-(?:llm-mock-server|llm-replay|loader-smoke|session-snapshot|remote-mock|tool-testkit|agent-loop-testkit|typert-generator)$/u, 'test and replay tooling'],
])

/** Measure a file or a directory tree. */
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
 * Delete every package a {@link DROP_RULES} entry matches.
 * @param {string} root - unpacked runtime tree, with `node_modules` at its top.
 * @returns {{ bytes: number, files: number, dropped: string[] }} what was removed.
 */
export function dropPackages(root) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  if (!existsSync(scope)) throw new Error(`${root} holds no node_modules/@deepseek-ai`)
  let bytes = 0
  let files = 0
  const dropped = []
  for (const name of readdirSync(scope)) {
    const full = join(scope, name)
    if (!statSync(full).isDirectory()) continue
    if (RETAINED.includes(`@deepseek-ai/${name}`)) continue
    const rule = DROP_RULES.find(([pattern]) => pattern.test(name))
    if (rule === undefined) continue
    const size = measure(full)
    rmSync(full, { recursive: true, force: true })
    bytes += size.bytes
    files += size.files
    dropped.push(`${basename(full)} (${(size.bytes / 1048576).toFixed(1)} MiB) — ${rule[1]}`)
  }
  return { bytes, files, dropped }
}

/**
 * Remove build residue no runtime reads.
 *
 * The same list `publish-runtime.mjs` strips from every artefact, because a node
 * consumes this tree the same way. `doc/` is deliberately absent: `yaml` ships
 * `dist/doc/directives.js`, which is code, and a path cannot tell the two apart
 * (measured — see that script's `STRIPPED`).
 * @param {string} root - unpacked runtime tree.
 * @param {ReadonlyArray<RegExp>} residue - patterns matched against `/`-joined relative paths.
 * @returns {{ bytes: number, files: number }} what was removed.
 */
export function stripResidue(root, residue) {
  let bytes = 0
  let files = 0
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const path = relative(root, full).replaceAll('\\', '/')
      const subject = entry.isDirectory() ? `${path}/` : path
      if (residue.some(pattern => pattern.test(subject))) {
        const size = measure(full)
        rmSync(full, { recursive: true, force: true })
        bytes += size.bytes
        files += size.files
        continue
      }
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return { bytes, files }
}
