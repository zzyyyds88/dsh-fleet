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
 * - a platform with no published artefact falls back to npm, which resolves natives
 *   correctly by construction.
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
 * @module @zzyyyds88/dsh-fleet/remote/artefact
 */

/** Default accelerator; overridable so a fork or a private mirror can be used. */
export const DEFAULT_MIRROR = 'https://git.yylx.win/'

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
 */
export const RUNTIME_BUILD = 2

/** The stamp file, relative to the runtime directory. */
export const BUILD_STAMP = '.fleet-artefact.json'

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
 * The accelerator works by prefixing the original URL, which is why this is a prefix
 * rather than a rewrite: `https://git.yylx.win/https://github.com/…`. The direct URL is
 * kept as the second candidate because the accelerator is a third-party hop — when it
 * is down, a node that *can* reach GitHub should still connect.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.platform - a `platformTag()` result.
 * @param {string} [options.repository]
 * @param {string} [options.mirror] - empty string means "go direct".
 * @param {string} [options.tag] - release tag; defaults to `v<version>`.
 * @returns {string[]} candidate URLs, best first.
 */
export function artefactUrls({ version, platform, repository = DEFAULT_REPOSITORY, mirror = DEFAULT_MIRROR, tag }) {
  const name = artefactName(version, platform)
  const releaseTag = tag ?? `v${version}`
  const official = `https://github.com/${repository}/${RELEASE_BASE}/${releaseTag}/${name}`
  if (mirror === '') return [official]
  const prefix = mirror.endsWith('/') ? mirror : `${mirror}/`
  return [`${prefix}${official}`, official]
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
 * | 3 | no artefact published for this platform/version | fall back to npm |
 * | 4 | checksum mismatch | roll back, report |
 * | 5 | archive is not a DSH runtime | roll back, report |
 *
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
printf '%s\n' '${build}' > "$runtime/${BUILD_STAMP}"
node "${shellPath(cli)}" --version
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
 * @param {string | undefined} input.build - the stamp the tree carries.
 * @param {string} input.wantedVersion
 * @returns {{ usable: boolean, reason: string }}
 */
export function inspectRuntime({ version, build, wantedVersion }) {
  if (version !== wantedVersion) {
    return { usable: false, reason: version === undefined ? 'no runtime installed' : `runtime is ${version}` }
  }
  if (build === undefined || build.trim() === '') {
    return { usable: false, reason: 'this runtime predates build stamps' }
  }
  const installed = Number.parseInt(build.trim(), 10)
  if (!Number.isFinite(installed)) {
    return { usable: false, reason: `unreadable build stamp ${build.trim()}` }
  }
  if (installed !== RUNTIME_BUILD) {
    return {
      usable: false,
      reason: `runtime was packed by build ${String(installed)}, this plugin packs build ${String(RUNTIME_BUILD)}`,
    }
  }
  return { usable: true, reason: 'in step' }
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
