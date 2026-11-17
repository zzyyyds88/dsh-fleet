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
 * @module @local/dsh-fleet/remote/artefact
 */

/** Default accelerator; overridable so a fork or a private mirror can be used. */
export const DEFAULT_MIRROR = 'https://git.yylx.win/'

/** GitHub repository the releases come from. */
export const DEFAULT_REPOSITORY = 'zzyyyds88/dsh-fleet'

/** Where a published node runtime lives. */
export const RELEASE_BASE = 'releases/download'

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
 * @returns {string}
 */
export function installScript({ version, runtime, cli, urls }) {
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
      curl -fLsS --connect-timeout 15 --retry 2 -o "$OUT" "$target" && return 0
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
