/**
 * The node's DSH runtime, fetched as a published artefact.
 *
 * Provisioning used to run `npm install @deepseek-ai/dsh@<version>` on every node.
 * That is a 1.3 GB install tree, several minutes, and it needs the node to reach a
 * registry — three things that make "connect to a machine" feel like "deploy a
 * service". The artefact route is the same idea ZCode uses: the desktop publishes the
 * runtime it was tested against and a node downloads exactly that tarball.
 *
 * **The tree in that tarball is this project's own build**, not the upstream release: it
 * comes from a fork of the upstream source with the browser surface, the Office engine and
 * the experimental bundles removed (see `docs/adr-0007-fork-node-runtime.zh.md` and
 * `scripts/build-fork-runtime.mjs`). A node runs what this project built and tested, which
 * is the whole reason the fork exists.
 *
 * **The artefact has to be per-platform, and that is not a detail.**
 *
 * A DSH installation is not pure JavaScript: `node-pty`, `sharp` and
 * `sherpa-onnx` ship native binaries, and the installed tree names the platform it was
 * built for (`sherpa-onnx-win-x64`, `@img/sharp-linux-x64`, …). Packing this Windows
 * desktop's tree and unpacking it on a Linux node would produce a node whose terminal
 * and image tools fail at first use — worse than the slow install it replaced, because
 * it fails later and further from the cause. So:
 *
 * - the file name carries the platform (`dsh-<version>-linux-x64.tar.gz`);
 * - the plugin asks for the artefact matching **the node's** `uname`, not its own;
 * - a platform this build publishes no artefact for is reported, not resolved elsewhere.
 *
 * Two more decisions:
 *
 * - **The checksum is published beside it.** A truncated download over a flaky link
 *   would otherwise unpack into a half-installed runtime that fails at first use
 *   instead of at download time.
 * - **The unpack is atomic.** The new tree is extracted beside the live one and only
 *   then renamed into place, so a failure leaves the previous runtime intact rather
 *   than a mixture of two releases.
 *
 * @module @greatbaby/dsh-fleet/remote/artefact
 */

/**
 * The accelerator prefixes that used to sit behind CNB, kept only as a record.
 *
 * They were a list because a single accelerator dies: measured on the test node, `git.yylx.win`
 * refused :443 outright while `gh.inkchills.cn` carried the archive at 2.4 MB/s, and the set
 * spans 0.2–9.6 MB/s run to run. None of them is a download source any more — see
 * {@link DEFAULT_SOURCES} for why the list became one host.
 *
 * `github.akams.cn` is the catalog these came from, not a proxy itself: asking it for
 * `/https://github.com/…` answers 404.
 */
export const RETIRED_MIRRORS = Object.freeze([
  'https://git.yylx.win/',
  'https://gh.inkchills.cn/',
  'https://tvv.tw/',
  'https://ghfast.top/',
])

/** GitHub repository the releases are also uploaded to, as a backup. */
export const DEFAULT_REPOSITORY = 'zzyyyds88/dsh-fleet'

/** Where a published node runtime lives on GitHub (backup only; nodes read CNB). */
export const RELEASE_BASE = 'releases/download'

/**
 * The primary source: CNB, a domestic host that serves release assets straight.
 *
 * **CNB is the only source.** The node has exactly one place to download from, and that
 * is a decision, not an accident of the list's length: GitHub is not reachable from the
 * machines this project serves, and every accelerator in front of it varies by a factor
 * of 40 between runs (measured on the test node, full archive: 0.2–9.6 MB/s). A source
 * list whose other entries are known-bad is a list that turns one failure into a
 * sequence of slow failures.
 *
 * The archive is also uploaded to the GitHub release (`build-fork-runtime.mjs --publish`),
 * as a backup and for the record. Nodes do not read it from there.
 *
 * **Measured on the test node, full 172 683 323-byte archive, not a HEAD request:**
 *
 *   cnb.cool         4 233 285 B/s   (~33 s for the whole archive, run-to-run spread under 1%)
 *   gh.inkchills.cn  ~2.4 MB/s
 *   tvv.tw           ~2.3 MB/s
 *   ghfast.top       ~0.7 MB/s
 *   git.yylx.win     connection refused at the time
 *
 * Public repository on purpose: the node holds **no CNB credential at all**, and an anonymous
 * `GET` of a public asset answers 302 into `asset.cnb.cool` with Range/206 support.
 */
export const CNB_REPOSITORY = 'serendipity-archive/dsh-fleet'

/** The CNB release URL shape, with the placeholders {@link artefactUrls} fills in. */
export const CNB_TEMPLATE =
  `https://cnb.cool/${CNB_REPOSITORY}/-/releases/download/{tag}/{file}`

/**
 * The one source a node downloads from.
 *
 * A `template` source builds the URL from `{version}`/`{platform}`/`{file}`/`{tag}`; a
 * `prefix` source would prepend itself to the canonical
 * `github.com/<repository>/releases/download/…` URL, which is what an accelerator *is*. No
 * prefix source is left: every accelerator in front of GitHub measured between 0.2 and
 * 9.6 MB/s on the same archive, and the machines this project serves cannot reach GitHub at
 * all. A `sources` array is still accepted, so a private mirror is one config value away.
 */
export const DEFAULT_SOURCES = Object.freeze([
  Object.freeze({ kind: 'template', template: CNB_TEMPLATE }),
])

/**
 * The packaging rules that produced an artefact.
 *
 * A version comparison says nothing about the *contents* of a tree: this plugin packs a
 * runtime itself, so the same `0.2.2-rc.3` can be published twice with different files
 * in it. When the packing changes — a strip rule added or removed — a node that already
 * has that version would never be reinstalled, and it would keep a tree this build
 * cannot run.
 *
 * Measured, not hypothesised: a strip rule that removed `doc/` also removed
 * `yaml/dist/doc/directives.js`, and every node installed from that artefact failed at
 * startup with `MODULE_NOT_FOUND`. The version was identical, so the gate said "current"
 * and nothing repaired it.
 *
 * **Bump this whenever `STRIPPED` in `scripts/publish-runtime.mjs` changes, or when the
 * archive layout changes.** It is written into the installed tree and compared on
 * connect; a node whose stamp is missing or older is reinstalled even though its version
 * matches.
 *
 * Build 3 changed what a tree contains, not just how it is packed: the packer resolves
 * with `--ignore-scripts`, so a released archive no longer carries the **packing machine's**
 * native build output. Measured on the rc.5 archive built the old way: 48 `.exe`/`.cmd`/
 * `.dll`/`.lib` files and 147 `koffi/build/win32_x64/**` entries inside a `linux-x64`
 * artefact, because koffi's `install` script compiles for `process.platform` — the
 * packer's, not the node's. The stamp format changed in the same build (see
 * {@link stampJson}), and a tree stamped `2` is packed by the old rules either way.
 *
 * Build 4 is the fork: the tree is built from this project's own copy of the upstream
 * source (`scripts/build-fork-runtime.mjs`) with the browser surface, the Office engine and
 * the experimental bundles removed — 2014.6 MiB unpacked → 408.6 MiB, measured. A build-3
 * tree is the upstream release, which is a different runtime at the same version, so it is
 * reinstalled rather than kept.
 */
export const RUNTIME_BUILD = 4

/** The stamp file, relative to the runtime directory. */
export const BUILD_STAMP = '.fleet-artefact.json'

/**
 * The stamp one install writes.
 *
 * Two facts, because one was not enough: **which build packed it** decides whether the tree
 * can be trusted (see {@link RUNTIME_BUILD}), and **how it got there** is what a person needs
 * when a node behaves differently from its neighbours.
 *
 * `via` is reported, never judged. It used to distinguish a downloaded artefact from a tree
 * the node resolved itself; the node no longer resolves its own (see
 * `docs/adr-0007-fork-node-runtime.zh.md`), so `artefact` is the only value this build
 * writes — the field stays because a stamp is read by nodes that predate the removal, and
 * because "where did this tree come from" is a question every future supply route asks.
 *
 * JSON rather than a bare integer so `via` could be added without a second file. Trees
 * stamped by build 2 hold `2` alone; {@link parseStamp} still reads those, because a node
 * already in service must not be judged unusable by a format change.
 *
 * @param {{ build?: number, via: 'artefact' | 'npm' }} input
 * @returns {string}
 */
export function stampJson({ build = RUNTIME_BUILD, via }) {
  return JSON.stringify({ build, via })
}

/**
 * Read a stamp written by {@link stampJson} or by an earlier build.
 *
 * @param {string | undefined} text
 * @returns {{ build: number | undefined, via: 'artefact' | 'npm' | undefined }}
 */
export function parseStamp(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { build: undefined, via: undefined }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const build = Number.parseInt(String(parsed?.build ?? ''), 10)
      const via = parsed?.via === 'npm' || parsed?.via === 'artefact' ? parsed.via : undefined
      return { build: Number.isFinite(build) ? build : undefined, via }
    } catch {
      // A half-written stamp is the same as no stamp: the tree gets reinstalled.
      return { build: undefined, via: undefined }
    }
  }
  // Build 2 and earlier: a bare integer, with no record of where the tree came from.
  const legacy = Number.parseInt(trimmed, 10)
  return { build: Number.isFinite(legacy) ? legacy : undefined, via: undefined }
}

/**
 * How long a download may sit below {@link FETCH_FLOOR_BYTES} per second before curl gives up.
 *
 * A runtime archive is ~170 MiB, so a *working* link needs minutes, not seconds: a plain
 * `--max-time` either kills healthy downloads on a slow line or lets a dead one run
 * forever. Measured, not hypothesised: on the test node the mirror pulled the whole
 * archive in 4 s while the direct GitHub fallback managed 925 KB in 30 s. The install
 * script lists both, so a mirror failure silently turns into a fallback that would run
 * for over an hour — which reads to the user as "connecting hangs" with nothing to see.
 * Giving up after a minute below the floor turns that into the named
 * `ARTEFACT_UNAVAILABLE` failure the caller already reports.
 */
export const FETCH_FLOOR_BYTES = 4096

/** Seconds below {@link FETCH_FLOOR_BYTES} before that download is abandoned. */
export const FETCH_FLOOR_SECONDS = 60

/**
 * Hard ceiling for one archive download, in seconds.
 *
 * 30 minutes is ~100 KB/s for a 170 MiB archive: slower than that is not a line anyone
 * can install a node over, and the budget still leaves room for a genuinely slow but
 * working link.
 */
export const FETCH_CEILING_SECONDS = 1800

/**
 * `uname -s` / `uname -m` names → the platform tag used in a Release asset name.
 *
 * Only the pairs this plugin can actually provision are listed. An unknown pair is not an
 * error: it means "no artefact for this machine", which is reported as such.
 */
const PLATFORM_ALIASES = Object.freeze({
  linux: 'linux',
  darwin: 'darwin',
  freebsd: 'freebsd',
  x86_64: 'x64',
  amd64: 'x64',
  x64: 'x64',
  aarch64: 'arm64',
  arm64: 'arm64',
  armv7l: 'arm',
  armv6l: 'arm',
  i686: 'ia32',
  i386: 'ia32',
})

/**
 * Normalize the probe's `uname` answers into a Release platform tag.
 *
 * `uname -s` is capitalised (`Linux`, `Darwin`) while npm and Node's own `process.platform`
 * are lowercase, and `uname -m` says `x86_64` where `process.arch` says `x64`. Both
 * translations happen here so the rest of the plugin only ever sees one spelling.
 *
 * @param {{ os?: string, arch?: string }} facts - the probe result.
 * @returns {string | undefined} e.g. `linux-x64`, or `undefined` when unrecognisable.
 */
export function platformTag(facts) {
  const os = PLATFORM_ALIASES[String(facts?.os ?? '').toLowerCase()]
  const arch = PLATFORM_ALIASES[String(facts?.arch ?? '').toLowerCase()]
  if (os === undefined || arch === undefined) return undefined
  return `${os}-${arch}`
}

/**
 * The artefact name for one DSH release on one platform.
 * @param {string} version
 * @param {string} platform - a `platformTag()` result, e.g. `linux-x64`.
 */
export function artefactName(version, platform) {
  return `dsh-${version}-${platform}.tar.gz`
}

/**
 * Absolute URLs of one artefact, best candidate first.
 *
 * A source is one of two things, because a download host is one of two things:
 *
 * - `{ kind: 'template', template }` — a host with its own path layout (CNB:
 *   `https://cnb.cool/<org>/<repo>/-/releases/download/<tag>/<file>`). Prefixing cannot express
 *   that shape, so the template is filled in instead.
 * - `{ kind: 'prefix', prefix }` — an accelerator, which works by prepending itself to the
 *   canonical `github.com/<repository>/releases/download/…` URL. None is configured by
 *   default (see {@link DEFAULT_SOURCES}); the kind stays supported so a private mirror is a
 *   configuration value rather than a code change.
 *
 * **There is no direct-GitHub candidate, on purpose.** Falling back to `github.com`
 * looks harmless and is not: measured on the test node it runs at ~27 KB/s, so a failed
 * download turns into 1.8 hours of apparent hang — the failure that started this. A
 * host that cannot reach the source is also a host where GitHub is slow or blocked,
 * so "try GitHub anyway" is the one fallback that is guaranteed to be worse than
 * reporting. When every source fails the install reports `ARTEFACT_UNAVAILABLE`
 * and the list gets fixed by hand, which is a decision a person makes once, not a
 * silent 1.8-hour wait on every connect.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.platform - a `platformTag()` result.
 * @param {string} [options.repository] - the GitHub repository a `prefix` source wraps.
 * @param {Array<{kind: 'prefix' | 'template', prefix?: string, template?: string}>} [options.sources]
 *   - replaces the default source list entirely.
 * @param {string} [options.tag] - release tag; defaults to `v${version}`.
 * @returns {string[]} candidate URLs, best first.
 * @throws when the resulting source list yields no candidate — a missing source is a
 *   configuration error, not a reason to download from GitHub directly.
 */
export function artefactUrls({
  version, platform, repository = DEFAULT_REPOSITORY, sources, tag,
}) {
  const name = artefactName(version, platform)
  const releaseTag = tag ?? `v${version}`
  const official = `https://github.com/${repository}/${RELEASE_BASE}/${releaseTag}/${name}`
  const list = sources ?? DEFAULT_SOURCES
  const candidates = []
  for (const source of list) {
    if (source?.kind === 'template') {
      const template = String(source.template ?? '')
      if (template === '') continue
      candidates.push(template
        .replaceAll('{version}', version)
        .replaceAll('{platform}', platform)
        .replaceAll('{tag}', releaseTag)
        .replaceAll('{file}', name))
      continue
    }
    if (source?.kind === 'prefix') {
      const prefix = String(source.prefix ?? '')
      if (prefix === '') continue
      candidates.push(`${prefix.endsWith('/') ? prefix : `${prefix}/`}${official}`)
      continue
    }
    // An unknown kind is a configuration mistake, and skipping it silently would leave a
    // source list that looks longer than the one actually tried.
    throw new Error(`unknown artefact source kind: ${JSON.stringify(source?.kind ?? null)}`)
  }
  if (candidates.length === 0) {
    throw new Error(
      'no artefact source configured: the node runtime is downloaded only through the '
      + 'source list (CNB; see DEFAULT_SOURCES), never straight from GitHub. Add at least '
      + 'one source.',
    )
  }
  return [...new Set(candidates)]
}

/**
 * The shell script that installs one runtime on the node.
 *
 * Written as one `sh -c` payload because a handful of round trips over a slow link
 * costs more than the script does, and every command here is one the probe has already
 * proved exists (`curl`/`wget`, `tar`, `sha256sum`/`shasum`).
 *
 * The archive's layout is the runtime directory itself — `node_modules/…` at the top —
 * because that is what the live runtime is on a node that npm once installed.
 *
 * `set -eu` is deliberate: a partially applied install must stop the connect, not
 * continue into a node that starts with half a runtime.
 *
 * The exit codes are the contract `RemoteHost.install` switches on:
 *
 * | code | meaning | what the caller does |
 * |---|---|---|
 * | 0 | installed | start the node |
 * | 3 | no source served it (`ARTEFACT_UNAVAILABLE`) | report the list it tried; never direct GitHub |
 * | 4 | checksum mismatch | roll back, report |
 * | 5 | archive is not a DSH runtime | roll back, report |
 */

/**
 * Turn a `~`-rooted path into something a shell expands inside double quotes.
 *
 * `~/.dsh-fleet/runtime` only expands when it is unquoted and at the start of a word.
 * This script quotes every path — a directory with a space in it must not break an
 * install — so the tilde has to be replaced by `$HOME` instead. Without this the script
 * happily creates a directory literally named `~` and then fails to download into it.
 *
 * @param {string} path
 */
function shellPath(path) {
  return path.startsWith('~/') ? `$HOME/${path.slice(2)}` : path
}

/**
 * The shell script that installs one runtime on the node.
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.runtime - the runtime directory, `~/.dsh-fleet/runtime`.
 * @param {string} options.cli - the CLI path inside that directory.
 * @param {string[]} options.urls - candidate download URLs.
 * @param {number} [options.build] - the packaging build, stamped into the tree.
 * @returns {string}
 */
export function installScript({ version, runtime, cli, urls, build = RUNTIME_BUILD }) {
  const checksumUrls = urls.map(url => `${url}.sha256`)
  const quote = list => list.map(url => `'${url}'`).join(' ')
  return `
set -eu
runtime="${shellPath(runtime)}"
staging="$runtime.incoming"
previous="$runtime.previous"
archive="$(dirname "$runtime")/runtime-${version}.tar.gz"
mkdir -p "$(dirname "$runtime")"
cd "$(dirname "$runtime")"

fetch() {
  for target in "$@"; do
    if command -v curl >/dev/null 2>&1; then
      curl -fLsS --connect-timeout 15 --retry 2 \\
        --speed-limit ${FETCH_FLOOR_BYTES} --speed-time ${FETCH_FLOOR_SECONDS} \\
        --max-time ${FETCH_CEILING_SECONDS} -o "$OUT" "$target" && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 20 -t 2 -O "$OUT" "$target" && return 0
    else
      echo "this machine has neither curl nor wget" >&2
      return 1
    fi
  done
  return 1
}

OUT="$archive"
if ! fetch ${quote(urls)}; then
  echo "ARTEFACT_UNAVAILABLE" >&2
  exit 3
fi

OUT="$archive.sha256"
if fetch ${quote(checksumUrls)}; then
  expected=$(cut -d' ' -f1 < "$archive.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$archive" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
  fi
  if [ "$expected" != "$actual" ]; then
    rm -f "$archive"
    echo "ARTEFACT_CHECKSUM_MISMATCH $expected $actual" >&2
    exit 4
  fi
fi

rm -rf "$staging"
mkdir -p "$staging"
tar -xzf "$archive" -C "$staging"
if [ ! -f "$staging/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  rm -rf "$staging"
  rm -f "$archive" "$archive.sha256"
  echo "ARTEFACT_SHAPE_UNEXPECTED" >&2
  exit 5
fi
# tar on a Windows packer writes 0666 for every entry — measured on the rc.5 archive:
# 51500 files at -rw-rw-rw-, and the only 20 entries carrying +x were Windows .exe/.cmd.
# On a Darwin node that turns node-pty/prebuilds/*/spawn-helper into a file the terminal
# can read but not execute, so the PTY fails at first use — later and further from the
# cause than any install failure. Restoring the bit here rather than only in the packer
# keeps archives that are already published working.
find "$staging" -type f -name 'spawn-helper' -exec chmod 0755 {} + 2>/dev/null || true

rm -rf "$previous"
if [ -d "$runtime" ]; then mv "$runtime" "$previous"; fi
mv "$staging" "$runtime"
rm -f "$archive" "$archive.sha256"
printf '%s\n' '${stampText({ build, via: 'artefact' })}' > "$runtime/${BUILD_STAMP}"
node "${shellPath(cli)}" --version
`.trim()
}

/**
 * Escape a stamp for a single-quoted shell string.
 *
 * The stamp is JSON, which contains double quotes — harmless in `'…'` — but a `'` inside it
 * would end the string early. Nothing writes one today; this keeps the script generator from
 * depending on that.
 * @param {{ build?: number, via: 'artefact' | 'npm' }} input
 */
function stampText(input) {
  const json = stampJson(input)
  if (json.includes("'")) throw new Error(`a build stamp may not contain a quote: ${json}`)
  return json
}

/**
 * Read the version an unpacked runtime reports, without starting it.
 *
 * Kept as `node -e` rather than a second download of `package.json`: the version a node
 * will actually run is the one in its own tree, and this reads exactly that.
 * @param {string} runtime - the runtime directory.
 */
export function installedVersionScript(runtime) {
  const manifest = shellPath(`${runtime}/node_modules/@deepseek-ai/dsh/package.json`)
  return `node -e 'const m=require(process.argv[1]);process.stdout.write(String(m.version))'`
    + ` "${manifest}" 2>/dev/null || echo`
}

/**
 * Read the packaging build of an installed tree, or empty when it has no stamp.
 *
 * A tree installed before stamps existed has none, which must read as "older than
 * anything this build publishes" rather than as "current": that is what repairs a node
 * left on a tree packed by an earlier, broken rule set.
 * @param {string} runtime
 */
export function installedBuildScript(runtime) {
  return `cat "${shellPath(runtime)}/${BUILD_STAMP}" 2>/dev/null || echo`
}

/**
 * Whether an installed tree can be trusted for this release.
 *
 * Both halves matter and neither implies the other: the version says *which release* the
 * tree is, and the stamp says *who packed it*. A node can be on the right version and
 * still be broken, which is exactly what a changed strip rule produces.
 *
 * @param {object} input
 * @param {string | undefined} input.version - the version the tree reports.
 * @param {string | undefined} input.build - the stamp the tree carries, in any format
 *   {@link parseStamp} reads.
 * @param {string} input.wantedVersion
 * @returns {{ usable: boolean, reason: string, via: 'artefact' | 'npm' | undefined }}
 */
export function inspectRuntime({ version, build, wantedVersion }) {
  const stamp = parseStamp(build)
  if (version !== wantedVersion) {
    return {
      usable: false,
      reason: version === undefined ? 'no runtime installed' : `runtime is ${version}`,
      via: stamp.via,
    }
  }
  if (stamp.build === undefined) {
    // Two different faults read the same from here, so the message says both: a tree from
    // before stamps existed has no file, and a tree whose stamp was cut short has a broken
    // one. Neither can be trusted, and both are repaired by the same reinstall.
    return {
      usable: false,
      reason: String(build ?? '').trim() === ''
        ? 'this runtime predates build stamps'
        : `unreadable build stamp ${String(build).trim()}`,
      via: undefined,
    }
  }
  if (stamp.build !== RUNTIME_BUILD) {
    return {
      usable: false,
      reason: `runtime was packed by build ${String(stamp.build)}, this plugin packs build ${String(RUNTIME_BUILD)}`,
      via: stamp.via,
    }
  }
  // `via` is reported, never judged: a tree the node resolved itself is as usable as a
  // downloaded one, and the whole point of the npm route is that the two are interchangeable.
  return { usable: true, reason: 'in step', via: stamp.via }
}

/**
 * Roll a failed install back to the tree that was there before.
 *
 * Called when the download succeeded but the unpack or the verification did not, so the
 * node keeps the release it had instead of a half-swapped directory.
 * @param {string} runtime
 */
export function rollbackScript(runtime) {
  return `
set -eu
runtime="${shellPath(runtime)}"
if [ -d "$runtime.previous" ]; then
  rm -rf "$runtime"
  mv "$runtime.previous" "$runtime"
  echo rolled-back
else
  echo nothing-to-roll-back
fi
rm -rf "$runtime.incoming"
`.trim()
}
