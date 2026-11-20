/**
 * Drop the parts of a forked DSH runtime a node never loads.
 *
 * The node is a **brain**: it composes `@deepseek-ai/dsh-base` plus
 * `@local/rnh-brain` and serves the Remote API. It renders nothing, so the
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
 * @module @greatbaby/dsh-remote-node-harness/scripts/trim-fork-runtime
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

/**
 * Build residue no runtime reads: type declarations, TypeScript sources, source maps,
 * debug symbols and package documentation. Kept here rather than in `publish-runtime.mjs`
 * so the fork build and the upstream artefact build strip exactly the same files — they
 * produce archives a node consumes identically, and a divergence between them would be a
 * difference in the artefact's contents at one version.
 *
 * **Every entry here was measured against the published archive, not guessed.** The first
 * version of this list had three rules that matched nothing at all:
 *
 * - `/(^|\/)\.md$/` matches a file whose *name* is exactly `.md`. `guide.md`, `HISTORY.md`
 *   and 600 other real documents all survived it — 5.3 MiB that shipped for no reason.
 *   Markdown is now matched by extension and rescued by {@link ARTEFACT_RESIDUE_KEEP}.
 * - `.d.cts` was missing while `.d.ts` and `.d.mts` were present, so zod's 7 110 declaration
 *   files (22.7 MiB) went out with every node.
 * - `.ts` sources were never covered. The tree loads `lib/*.js`; 9 534 `src/*.ts` files
 *   (91.9 MiB) were dead weight. Deleting them is safe because **no manifest on a Node
 *   resolution path names a `.ts` file** — checked across 1 207 manifests, looking only at
 *   `main`, `bin` and the `import`/`require`/`default`/`node` conditions of `exports`; the
 *   `types` and custom conditions (zod's `@zod/source`) that do point at `.ts` are read by a
 *   bundler or a type checker, never by `import`. No runtime file imports a `.ts` specifier
 *   and none reads one as data either.
 *
 * `doc/` as a *directory* is still deliberately absent: `yaml` ships
 * `dist/doc/directives.js`, which is code, and a path cannot tell the two apart (measured —
 * a `docs?/` rule removed it and every node installed from that artefact failed with
 * `MODULE_NOT_FOUND`). Markdown *files* are a different question and are safe.
 * @type {ReadonlyArray<RegExp>}
 */
export const ARTEFACT_RESIDUE = Object.freeze([
  /\.d\.ts$/u,
  /\.d\.cts$/u,
  /\.d\.mts$/u,
  /\.map$/u,
  // A `.ts`/`.tsx` that is not a declaration. The lookbehind keeps `x.d.ts` out; `.d.cts`
  // and `.d.mts` cannot match `\.ts$` at all because they end in `cts`/`mts`.
  /(?<!\.d)\.ts$/u,
  /\.tsx$/u,
  // Windows debug symbols inside a Linux artefact.
  /\.pdb$/u,
  /(^|\/)README(\.[^/]*)?$/iu,
  /(^|\/)CHANGELOG(\.[^/]*)?$/iu,
  /(^|\/)\.github\//u,
  /(^|\/)(test|tests|__tests__)\//u,
  /\.md$/iu,
])

/**
 * Markdown an agent loads at runtime, which the `.md` rule above must not touch.
 *
 * Found by searching every `.js`/`.cjs`/`.mjs` in the tree for `readFile…new URL(…'.md')`
 * and for `SKILL.md` path joins. Exactly these shapes came back:
 *
 * - `dsh-skill-filesystem` joins `entry.path` with `SKILL.md`, and the packaged Office
 *   skills are `assets/<skill>/SKILL.md`;
 * - `dsh-creation-recommendations` reads `skills/personalized-pages.md` and its
 *   `references/*.md` page specs;
 * - `dsh-plugin-recommendations` reads `skills/official-plugins.md`;
 * - `dsh-skill-badge` reads `assets/dsh-badge.md`;
 * - `dsh-agent-preset` ships the `dsh-doc` skill: `skills/dsh-doc/{SKILL.md,references/*,
 *   templates/**}` — the templates are scaffolding an agent copies into a new plugin.
 *
 * `@deepseek-ai/dsh/docs/` is the sixth, and it is the one that made the first version of
 * this list wrong. **No code reads it** — an agent does: the `dsh-doc` skill's own
 * `references/locate-docs.md` tells the reader to open `DSH_INSTALL_DIR/docs/user/index.md`
 * and `docs/upgrade-guide/README.md`, and the skill ships in the brain composition
 * (`skill-filesystem` with `customSkillDirs` pointing at `@deepseek-ai/dsh-agent-preset`).
 * A strip rule that only looks for `import`/`readFile` cannot see a path spelled out in
 * prose, so this one is kept because a *capability the node keeps* names it. Measured:
 * 481 files, 4.66 MiB — the price of not shipping a skill that points at nothing.
 * @type {ReadonlyArray<RegExp>}
 */
export const ARTEFACT_RESIDUE_KEEP = Object.freeze([
  /(^|\/)SKILL\.md$/u,
  /(^|\/)skills\//u,
  /(^|\/)assets\//u,
  /(^|\/)references\//u,
  /(^|\/)templates\//u,
  /(^|\/)@deepseek-ai\/dsh\/docs\//u,
])

/**
 * Native binaries for a platform this artefact will never run on.
 *
 * `node-pty` picks its binary by string concatenation — `prebuilds/${process.platform}-${process.arch}`
 * (`lib/utils.js`) — so exactly one of its six prebuild directories can ever be loaded. The
 * Windows ones carry `conpty` (an `.exe`, a `.dll` and `.pdb` debug symbols) that a Linux node
 * cannot execute; measured on the build-4 archive, 23.2 MiB of `prebuilds/` of which 0.07 MiB
 * was the one directory that loads.
 *
 * This is a function rather than an entry in {@link ARTEFACT_RESIDUE} because the answer depends
 * on the artefact being packed: a darwin archive must keep `darwin-*`, and hard-coding "strip
 * win32" would silently break the day another platform ships. `PUBLISHED_PLATFORMS` is one
 * platform today, so this only ever removes bytes, but the rule stays honest either way.
 * @param {string} platform - `linux-x64`, `darwin-arm64`, …
 * @returns {ReadonlyArray<RegExp>} patterns for every native payload of another platform.
 */
export function foreignPlatformResidue(platform) {
  const patterns = [
    // `prebuilds/<os>-<arch>/` where `<os>-<arch>` is not this artefact's platform. The
    // lookahead is what makes "not this one" expressible without listing the others: the
    // directory must not *continue* as the shipped platform, but must still match the shape.
    new RegExp(`(^|/)prebuilds/(?!${platform}/)[a-z0-9]+-[a-z0-9]+/`, 'u'),
  ]
  if (!platform.startsWith('win32')) {
    // node-pty's Windows ConPTY payload, which it reads only on win32.
    patterns.push(/(^|\/)third_party\/conpty\//u)
    // Executables, debug symbols and shell shims of another OS that survived the directory
    // rules. The `.cmd`/`.ps1` pair is what npm writes next to every `.bin/` entry — 26 files,
    // 15 KiB, referenced by nothing on Linux (`sh` runs the extensionless one).
    patterns.push(/\.(exe|dll|pdb|cmd|ps1)$/u)
  }
  return patterns
}

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
 * consumes this tree the same way.
 *
 * `keepMarkdown` is what makes the `.md` rule safe, and it applies **only to markdown**.
 * That restriction is load-bearing rather than tidy: the first version consulted the keep
 * list for every path, and `skills/` then rescued `openai/src/resources/skills/*.ts` —
 * thirteen TypeScript sources that have nothing to do with documentation, left in the tree
 * because their directory happened to be called `skills`. A rescue is an exception to one
 * rule, not a blanket exemption from all of them.
 * @param {string} root - unpacked runtime tree.
 * @param {ReadonlyArray<RegExp>} residue - patterns matched against `/`-joined relative paths.
 * @param {ReadonlyArray<RegExp>} keepMarkdown - markdown paths the `.md` rule must not touch.
 * @returns {{ bytes: number, files: number }} what was removed.
 */
export function stripResidue(root, residue, keepMarkdown = []) {
  let bytes = 0
  let files = 0
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const path = relative(root, full).replaceAll('\\', '/')
      // A directory is matched with a trailing slash so a file-shaped pattern (`.md`)
      // cannot take a whole tree with it, and a directory-shaped one (`test/`) cannot
      // match an unrelated file.
      const subject = entry.isDirectory() ? `${path}/` : path
      if (!entry.isDirectory() && path.endsWith('.md') && keepMarkdown.some(pattern => pattern.test(subject))) {
        continue
      }
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
