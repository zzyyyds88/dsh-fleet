/**
 * The node's DSH runtime, fetched as a published artefact instead of built on the
 * node.
 *
 * Provisioning used to run `npm install @deepseek-ai/dsh@<version>` on every node.
 * That is a 1.3 GB install tree, several minutes, and it needs the node to reach a
 * registry — three things that make "connect to a machine" feel like "deploy a
 * service". The artefact route is the same idea ZCode uses: the desktop publishes the
 * runtime it was tested against and a node downloads exactly that tarball.
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
 * - a platform with no artefact at all (an `uname` this plugin cannot tag) is the one
 *   case that goes to npm, which resolves natives correctly by construction. A platform
 *   this build *does* publish for never falls back: failing to download is reported.
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
 * Default accelerators, best first; overridable so a fork or a private mirror can be used.
 *
 * These are the hosts a node actually downloads from, and they die: a proxy that answers
 * today can refuse the connection tomorrow. **Measured on the test node**, full archive
 * (172 683 323 bytes), not a HEAD request:
 *
 *   git.yylx.win     connection refused on :443 right now, but it is the project's
 *                    first-choice accelerator (AGENTS.md §13) and a refused connection
 *                    costs one instant attempt, so it stays first — when it comes back
 *                    this is the fastest path again;
 *   gh.inkchills.cn  70.8 s  (~2.4 MB/s)   ← the one that actually carries today;
 *   tvv.tw           ~2.3 MB/s;
 *   ghfast.top       ~0.7 MB/s;
 *   (direct GitHub)  ~27 KB/s — **deliberately not in this list**, see artefactUrls().
 *
 * Order matters only for healthy hosts: the install script tries them in turn and a
 * connection refused costs milliseconds. What it must never do is end at GitHub direct,
 * where 165 MiB is 1.8 hours.
 *
 * `github.akams.cn` is the catalog these alternatives come from, not a proxy itself:
 * asking it for `/https://github.com/…` answers 404. Look there for a replacement when a
 * host here stops working.
 */
export const DEFAULT_MIRRORS = Object.freeze([
  'https://git.yylx.win/',
  'https://gh.inkchills.cn/',
  'https://tvv.tw/',
  'https://ghfast.top/',
])

/** GitHub repository the releases come from. */
export const DEFAULT_REPOSITORY = 'zzyyyds88/dsh-fleet'

/** Where a published node runtime lives. */
export const RELEASE_BASE = 'releases/download'

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
 * Build 3 changes what a tree contains, not just how it is packed: the packer now resolves
 * with `--ignore-scripts`, so a released archive no longer carries the **packing machine's**
 * native build output. Measured on the rc.5 archive built the old way: 48 `.exe`/`.cmd`/
 * `.dll`/`.lib` files and 147 `koffi/build/win32_x64/**` entries inside a `linux-x64`
 * artefact, because koffi's `install` script compiles for `process.platform` — the
 * packer's, not the node's. The stamp format changed in the same build (see
 * {@link stampJson}), and a tree stamped `2` is packed by the old rules either way.
 */
export const RUNTIME_BUILD = 3

/** The stamp file, relative to the runtime directory. */
export const BUILD_STAMP = '.fleet-artefact.json'

/**
 * The stamp one install writes.
 *
 * Two facts, because one was not enough: **which build packed it** decides whether the tree
 * can be trusted (see {@link RUNTIME_BUILD}), and **how it got there** is what a person needs
 * when a node behaves differently from its neighbours — a tree the node resolved itself has
 * the node's own native packages, a downloaded artefact has the packer's.
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
 * Only the pairs this plugin can actually provision are listed. An unknown pair is not
 * an error: it means "no artefact for this machine", which is what the npm fallback is
 * for.
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
 * An accelerator works by prefixing the original URL, which is why this is a prefix
 * rather than a rewrite: `https://gh.inkchills.cn/https://github.com/…`.
 *
 * **There is no direct-GitHub candidate, on purpose.** Falling back to `github.com`
 * looks harmless and is not: measured on the test node it runs at ~27 KB/s, so a failed
 * accelerator turns into 1.8 hours of apparent hang — the failure that started this. A
 * host that cannot reach any accelerator is also a host where GitHub is slow or blocked,
 * so "try GitHub anyway" is the one fallback that is guaranteed to be worse than
 * reporting. When every accelerator fails the install reports `ARTEFACT_UNAVAILABLE`
 * and the list gets fixed by hand, which is a decision a person makes once, not a
 * silent 1.8-hour wait on every connect.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.platform - a `platformTag()` result.
 * @param {string} [options.repository]
 * @param {string[]} [options.mirrors] - accelerator prefixes; at least one is required.
 * @param {string} [options.tag] - release tag; defaults to `v${version}`.
 * @returns {string[]} candidate URLs, best first.
 * @throws when the configured accelerator list yields no candidate — a missing
 *   accelerator is a configuration error, not a reason to download from GitHub directly.
 */
export function artefactUrls({
  version, platform, repository = DEFAULT_REPOSITORY, mirrors = DEFAULT_MIRRORS, tag,
}) {
  const name = artefactName(version, platform)
  const releaseTag = tag ?? `v${version}`
  const official = `https://github.com/${repository}/${RELEASE_BASE}/${releaseTag}/${name}`
  const candidates = []
  for (const mirror of mirrors) {
    if (mirror === '') continue
    candidates.push(`${mirror.endsWith('/') ? mirror : `${mirror}/`}${official}`)
  }
  if (candidates.length === 0) {
    throw new Error(
      'no accelerator configured: the node runtime is downloaded only through the '
      + 'accelerator list, never straight from GitHub (see DEFAULT_MIRRORS). '
      + 'Add at least one accelerator to `mirrors`.',
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
 * | 3 | every accelerator failed (`ARTEFACT_UNAVAILABLE`) | report the list it tried; never npm, never direct GitHub |
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
 * npm's platform flags for one node, from its own `uname` and libc.
 *
 * This is the half that makes a **node-side** resolve produce the right native packages:
 * with `--os/--cpu/--libc` npm picks `@img/sharp-linux-x64`, `sherpa-onnx-linux-x64` and
 * `@koromix/koffi-linux-x64` instead of whatever the resolving machine happens to be.
 * Measured: `npm ci` with these flags on a Windows machine skips `@img/sharp-win32-x64`
 * and `sherpa-onnx-win-x64` and installs the Linux ones.
 *
 * **Empty means "let npm decide from the process it runs in"** — which is correct on the
 * node, because the node's own npm *is* running on the node. That is the one place where
 * guessing is unnecessary rather than dangerous. It is used when the probe could not name
 * the platform.
 *
 * @param {{ os?: string, arch?: string, libc?: string }} facts
 * @returns {string[]}
 */
export function npmPlatformFlags(facts) {
  const os = PLATFORM_ALIASES[String(facts?.os ?? '').toLowerCase()]
  const cpu = PLATFORM_ALIASES[String(facts?.arch ?? '').toLowerCase()]
  if (os === undefined || cpu === undefined) return []
  const flags = [`--os=${os}`, `--cpu=${cpu}`]
  // Only Linux splits its prebuilds by C library (`glibc` vs `musl`): koffi and sharp both
  // ship both, and asking for the wrong one installs a binary that cannot be loaded. npm
  // rejects the flag on other platforms, so it is not passed there.
  if (os === 'linux') {
    const libc = String(facts?.libc ?? '').toLowerCase()
    flags.push(`--libc=${libc.includes('musl') ? 'musl' : 'glibc'}`)
  }
  return flags
}

/**
 * The shell script that resolves a runtime **on the node itself**.
 *
 * The fallback route, not the preferred one: an artefact is one download with no registry
 * and no decision, while this is a full resolve. It exists so that a release with no
 * published artefact is a slower connect rather than a dead end — which is what makes an
 * upstream DSH bump something this project can follow without anyone pre-building a tree.
 *
 * Three things it does that a plain `npm install` would not:
 *
 * 1. `--engine-strict=false` — **fail-open on the engine declaration, on purpose.**
 *    `@deepseek-ai/dsh` declares `engines.node: ">=24.9.0"` for every 0.2.2 release
 *    (`rc.1` through `rc.5`, all four checked), while the node in service runs
 *    Node v22.20.0 and has been running rc.3 on it. A gate the artefact route never applied
 *    cannot become a hard stop just because the install came from npm; the version is
 *    reported instead (see `engineWarning`) so the mismatch is visible without being fatal.
 * 2. The install **is** the node's own platform, so build scripts are allowed to run —
 *    unlike the packer, which must not run them (they would build for the wrong machine).
 * 3. It writes the same {@link BUILD_STAMP} the artefact route writes. Without it,
 *    `inspectRuntime` reads the tree as "predates build stamps" and reinstalls it on every
 *    connect: a one-minute install becomes a permanent one-minute connect.
 *
 * @param {object} options
 * @param {string} options.version - the exact release, never a range.
 * @param {string} options.runtime
 * @param {string} options.cli
 * @param {string[]} [options.flags] - `npmPlatformFlags()` output.
 * @param {string} [options.registry] - omit to use the node's own npm configuration.
 * @param {number} [options.build]
 * @returns {string}
 */
export function npmInstallScript({
  version, runtime, cli, flags = [], registry, build = RUNTIME_BUILD,
}) {
  const dir = shellPath(runtime)
  const registryFlag = typeof registry === 'string' && registry !== ''
    ? ` --registry='${registry.replace(/'/gu, '')}'`
    : ''
  return `
set -eu
runtime="${dir}"
mkdir -p "$runtime"
cd "$runtime"
if [ ! -f package.json ]; then
  printf '%s\n' '{"name":"dsh-fleet-runtime","private":true}' > package.json
fi
npm install --no-audit --no-fund --loglevel=error --engine-strict=false${registryFlag} ${flags.join(' ')} "@deepseek-ai/dsh@${version}" >&2
node "${shellPath(cli)}" --version
printf '%s\n' '${stampText({ build, via: 'npm' })}' > "$runtime/${BUILD_STAMP}"
node -e '
const fs = require("fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const wanted = String(manifest.engines?.node ?? "").replace(/^[^0-9]*/u, "")
const running = process.versions.node.split(".").map(Number)
const floor = wanted.split(".").map(Number)
const ok = wanted === "" || running[0] > floor[0]
  || (running[0] === floor[0] && running[1] > (floor[1] || 0))
  || (running[0] === floor[0] && running[1] === (floor[1] || 0) && running[2] >= (floor[2] || 0))
process.stdout.write(ok ? "" : "ENGINE_MISMATCH " + process.versions.node + " " + wanted)
' "$runtime/node_modules/@deepseek-ai/dsh/package.json"
`.trim()
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
