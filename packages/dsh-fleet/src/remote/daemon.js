/**
 * Remote runtime lifecycle for one node: probe the machine, ensure a usable
 * Node and a DSH installation, start the resident host, and read back the fact
 * that it is serving.
 *
 * The resident host is the whole point of this plugin. Every tool the agent
 * runs afterwards executes inside that process, on that machine, against that
 * machine's own filesystem and binaries: `rg`, `git`, `read_image`, `bash` and
 * the PTY all behave like a local install because they *are* a local install.
 * Nothing is mirrored, copied or translated.
 *
 * It is, however, a **separate DSH installation** with its own `~/.dsh`, which is why
 * this plugin writes a profile of its own there: `~/.dsh/profiles/fleet`, composed as
 * `dsh-base` + `@local/dsh-fleet-brain`, with the model rows and permission preset in
 * that profile's `cordis.patch.yml`.
 *
 * That file choice is load-bearing rather than cosmetic. `dsh-hmr` watches exactly two
 * paths — a profile's `cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml` — so writing
 * the profile patch is what lets this Host change a running node's model roster or key
 * **without restarting it**. A `--patch` overlay is not watched (measured; see
 * `docs/adr-0001-node-config-carrier.zh.md`).
 *
 * @module @local/dsh-fleet/remote/daemon
 */
import { createHash } from 'node:crypto'
import { SSH_FAILURE, toSshError } from '../ssh/connection.js'

/** The Node major version the resident host needs. */
export const MINIMUM_NODE_MAJOR = 22

/**
 * The bundle list an untouched `web` profile has.
 *
 * Mirrors `PROFILE_TEMPLATES.web` in `@deepseek-ai/dsh-official-bundles`. It is
 * duplicated rather than imported because this plugin keeps zero upstream imports
 * (see `AGENTS.md`), and because restoring a profile is a one-time repair, not a
 * long-lived contract: if upstream ever changes the template, a node whose `web`
 * profile was mutated simply ends up composing the older list, which is still a
 * working web app.
 */
const WEB_PROFILE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

/**
 * The profile this plugin owns on a node.
 *
 * It is deliberately its own profile rather than the upstream `web` one: a profile
 * has exactly one `cordis.patch.yml`, and that file is the **only** configuration
 * carrier the running host hot-reloads. Sharing `web` would mean this plugin and
 * anything else on the node writing the same file. See `docs/adr-0001`.
 */
export const NODE_PROFILE = 'fleet'

/** Files this plugin owns on a remote machine, relative to the node's root. */
export const REMOTE_LAYOUT = Object.freeze({
  root: '~/.dsh-fleet',
  runtime: '~/.dsh-fleet/runtime',
  run: '~/.dsh-fleet/run',
  log: '~/.dsh-fleet/run/host.log',
  status: '~/.dsh-fleet/run/status.json',
  /** The overlay earlier builds wrote and passed as `--patch`. Kept only so a
   * reconnect can remove it; the profile patch below is the live carrier. */
  legacyPatch: '~/.dsh-fleet/run/brain.patch.yml',
  packageJson: '~/.dsh-fleet/runtime/package.json',
  cli: '~/.dsh-fleet/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
  /** The node's DSH home and the profile this plugin owns. */
  home: '~/.dsh',
  profile: `~/.dsh/profiles/${NODE_PROFILE}`,
  /** The profile's own patch: the watched file, so config changes need no restart. */
  profilePatch: `~/.dsh/profiles/${NODE_PROFILE}/cordis.patch.yml`,
  /** Where the Loader resolves a bundle's row names from for that profile. */
  profileModules: `~/.dsh/profiles/${NODE_PROFILE}/node_modules`,
  /** The profile earlier builds mutated. Reverted on connect, never deleted. */
  legacyProfile: '~/.dsh/profiles/web',
})

const PROBE_COMMAND = `
set -u
printf 'BEGIN\\n'
printf 'os=%s\\n' "$(uname -s 2>/dev/null || echo unknown)"
printf 'arch=%s\\n' "$(uname -m 2>/dev/null || echo unknown)"
printf 'home=%s\\n' "$HOME"
printf 'node=%s\\n' "$(command -v node 2>/dev/null || echo)"
printf 'node_version=%s\\n' "$(node -v 2>/dev/null || echo)"
printf 'npm=%s\\n' "$(command -v npm 2>/dev/null || echo)"
printf 'git=%s\\n' "$(command -v git 2>/dev/null || echo)"
printf 'tar=%s\\n' "$(command -v tar 2>/dev/null || echo)"
printf 'curl=%s\\n' "$(command -v curl 2>/dev/null || echo)"
printf 'wget=%s\\n' "$(command -v wget 2>/dev/null || echo)"
printf 'setsid=%s\\n' "$(command -v setsid 2>/dev/null || echo)"
printf 'shell=%s\\n' "$SHELL"
printf 'END\\n'
`.trim()

/** Parse the `key=value` block the probe prints. */
export function parseProbeOutput(stdout) {
  const facts = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key === '' || key === 'BEGIN' || key === 'END') continue
    facts[key] = line.slice(at + 1).trim()
  }
  return facts
}

/** A probe result normalized for the settings UI. */
export function describeProbe(facts) {
  const major = Number.parseInt((facts.node_version ?? '').replace(/^v/u, ''), 10)
  return {
    os: facts.os ?? 'unknown',
    arch: facts.arch ?? 'unknown',
    home: facts.home ?? '',
    nodePath: facts.node ?? '',
    nodeVersion: facts.node_version ?? '',
    nodeMajor: Number.isFinite(major) ? major : 0,
    nodeUsable: Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR,
    npmPath: facts.npm ?? '',
    gitPath: facts.git ?? '',
    tarPath: facts.tar ?? '',
    curlPath: facts.curl ?? '',
    wgetPath: facts.wget ?? '',
    setsidPath: facts.setsid ?? '',
    shell: facts.shell ?? '',
  }
}

/** The remote helper that owns one node's resident host. */
export class RemoteHost {
  /**
   * @param {object} options
   * @param {import('../ssh/connection.js').SshConnection} options.connection
   * @param {string} options.version - the DSH version this profile runs.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.connection = options.connection
    this.version = options.version
    this.log = options.log ?? (() => {})
    /** @type {{ port: number, token: string, pid: number, version: string } | undefined} */
    this.serving = undefined
  }

  /** Inspect the machine. */
  async probe() {
    const result = await this.connection.exec({ argv: ['sh', '-c', PROBE_COMMAND], timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw toSshError(new Error(`remote probe failed (exit ${String(result.code)}): ${result.stderr.trim()}`))
    }
    return describeProbe(parseProbeOutput(result.stdout))
  }

  /** Read the recorded host status, or `undefined` when there is no host. */
  async status() {
    const result = await this.connection.exec({
      argv: ['sh', '-c', `cat ${REMOTE_LAYOUT.status} 2>/dev/null || echo '{}'`],
      timeoutMs: 20_000,
    })
    const text = result.stdout.trim()
    if (text === '' || text === '{}') return undefined
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /** Whether one recorded pid is still alive. */
  async isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    const result = await this.connection.exec({
      argv: ['sh', '-c', `kill -0 ${String(pid)} 2>/dev/null && echo alive || echo dead`],
      timeoutMs: 15_000,
    })
    return result.stdout.includes('alive')
  }

  /** Install or upgrade the resident DSH under the node's root. */
  async install(facts) {
    if ((facts.npmPath ?? '') === '') {
      throw toSshError(new Error(
        'this machine has no npm, so the resident DSH cannot be installed. '
        + 'Install Node.js 22 or newer (which ships npm) and connect again.',
      ))
    }
    if (!facts.nodeUsable) {
      throw toSshError(new Error(
        `this machine runs Node ${facts.nodeVersion || '(none)'}, but the resident host needs Node ${String(MINIMUM_NODE_MAJOR)} or newer. `
        + 'Install a newer Node.js and connect again.',
      ))
    }
    const script = `
set -eu
mkdir -p ${REMOTE_LAYOUT.runtime} ${REMOTE_LAYOUT.run}
cd ${REMOTE_LAYOUT.runtime}
if [ ! -f package.json ]; then
  printf '{"name":"dsh-fleet-runtime","private":true}\\n' > package.json
fi
npm install --no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@${this.version}" >&2
node ${REMOTE_LAYOUT.cli} --version
`.trim()
    const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 15 * 60_000, maxBytes: 1024 * 1024 })
    if (result.code !== 0) {
      throw toSshError(new Error(`installing the resident host failed: ${(result.stderr || result.stdout).trim().slice(-800)}`))
    }
    return result.stdout.trim().split('\n').at(-1) ?? this.version
  }

  /** Read the installed resident version, or `undefined` when absent. */
  async installedVersion() {
    const result = await this.connection.exec({
      argv: ['sh', '-c', `node ${REMOTE_LAYOUT.cli} --version 2>/dev/null || echo`],
      timeoutMs: 30_000,
    })
    const text = result.stdout.trim().split('\n').at(-1) ?? ''
    return /^\d+\.\d+\.\d+/u.test(text) ? text : undefined
  }

  /**
   * Write the profile patch — the model roster and permission preset — and report
   * whether the bytes changed.
   *
   * This file is `~/.dsh/profiles/fleet/cordis.patch.yml`, one of the two paths the
   * resident host hot-reloads (`dsh-hmr` watches the profile patch and the home
   * patch; a `--patch` overlay is **not** watched — see `docs/adr-0001`). Writing it
   * therefore reconfigures a running node without restarting it.
   *
   * The payload travels base64-encoded: the patch is YAML assembled from model
   * configuration, and a heredoc would break on any line that happened to match the
   * delimiter.
   * @param {string} text
   * @returns {Promise<{ changed: boolean }>}
   */
  async writePatch(text) {
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    const script = `
set -eu
mkdir -p ${REMOTE_LAYOUT.profile}
target=${REMOTE_LAYOUT.profilePatch}
tmp="$target.new"
printf '%s' '${encoded}' | base64 -d > "$tmp"
if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
  rm -f "$tmp"
  echo unchanged
else
  mv "$tmp" "$target"
  echo written
fi
# An overlay from an earlier build is dead weight: the profile patch replaces it and
# the launch line no longer passes --patch.
rm -f ${REMOTE_LAYOUT.legacyPatch}
`.trim()
    const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 60_000 })
    if (result.code !== 0) {
      throw toSshError(new Error(`writing the node config failed: ${(result.stderr || result.stdout).trim().slice(-400)}`))
    }
    return { changed: result.stdout.includes('written') }
  }

  /**
   * Install the brain bundle under the node's DSH runtime, and point the profile
   * at it.
   *
   * This is the source-level customisation of the node: the profile composes
   * `dsh-base` + `@local/dsh-fleet-brain` instead of `dsh-base` + `dsh-web-app`, so
   * the node never loads the browser surface at all — it is not loaded and then
   * disabled, it is absent from the composition.
   *
   * The package lands in the **profile's** `node_modules`, which is where the
   * Loader resolves a bundle's row names from (a profile's interception layer is
   * its own `node_modules`). It is written by `exec`, not SFTP: one `sh` round trip
   * for the whole tree beats a dozen SFTP round trips on a slow link, and the runtime
   * is already a directory this plugin owns.
   *
   * @param {Record<string, string>} files - package-relative path → contents.
   * @param {string} packageName - the bundle's package name.
   * @returns {Promise<{ changed: boolean, files: number }>}
   */
  async writeBrainBundle(files, packageName) {
    const target = `${REMOTE_LAYOUT.profileModules}/${packageName}`
    // A digest over path+content decides `changed` without shipping the tree twice.
    const digest = createHash('sha256')
    for (const path of Object.keys(files).sort()) {
      digest.update(path).update('\0').update(files[path]).update('\0')
    }
    const wanted = digest.digest('hex')
    const stamp = `${target}/.fleet-digest`

    const payload = Object.entries(files).map(([path, text]) => ({
      path,
      // `base64 -d` per file keeps a heredoc out of the picture entirely.
      data: Buffer.from(text, 'utf8').toString('base64'),
    }))
    const script = `
set -eu
target=${target}
stamp=${stamp}
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "${wanted}" ]; then
  echo unchanged
  exit 0
fi
rm -rf "$target"
mkdir -p "$target"
cd "$target"
while IFS='\t' read -r rel data; do
  mkdir -p "$(dirname "$rel")"
  printf '%s' "$data" | base64 -d > "$rel"
done <<'FLEET_BRAIN_FILES_EOF'
${payload.map(file => `${file.path}\t${file.data}`).join('\n')}
FLEET_BRAIN_FILES_EOF
printf '%s' "${wanted}" > "$stamp"
echo written
`.trim()
    const result = await this.connection.exec({
      argv: ['sh', '-c', script],
      timeoutMs: 120_000,
      // The script echoes nothing but its verdict, so a small cap is enough.
      maxBytes: 64 * 1024,
    })
    if (result.code !== 0) {
      throw toSshError(new Error(
        `installing the brain bundle failed: ${(result.stderr || result.stdout).trim().slice(-600)}`,
      ))
    }
    return { changed: result.stdout.includes('written'), files: Object.keys(files).length }
  }

  /**
   * Point the plugin's own profile at `bundles`, writing its manifest only when it
   * differs, and make sure a patch file exists for the host to hot-reload.
   *
   * The profile manifest is the *only* place the bundle list lives, so this is what
   * makes a node a brain rather than a web app. Two profiles matter here:
   *
   * - `~/.dsh/profiles/fleet` — this plugin's own profile, written here.
   * - `~/.dsh/profiles/web` — the profile earlier builds mutated. Its bundle list is
   *   put back to the upstream default so a node is not left composing a brain it
   *   is no longer started with. The directory itself is left alone: it may hold the
   *   user's own sessions and settings, so deleting it is not ours to do.
   *
   * @param {readonly string[]} bundles
   * @returns {Promise<{ changed: boolean, revertedPrevious: boolean }>}
   */
  async writeProfileBundles(bundles) {
    const manifestPath = `${REMOTE_LAYOUT.profile}/package.json`
    const read = await this.connection.exec({
      argv: ['sh', '-c', `cat ${manifestPath} 2>/dev/null || echo '{}'`],
      timeoutMs: 15_000,
    })
    /** @type {Record<string, unknown>} */
    let manifest = {}
    try {
      manifest = JSON.parse(read.stdout)
    } catch {
      // A corrupt manifest is replaced rather than preserved: it cannot compose
      // anything, and keeping its bytes would only hide that.
    }
    const current = manifest?.dsh?.profile?.bundles
    const same = Array.isArray(current) && current.length === bundles.length
      && current.every((name, index) => name === bundles[index])

    let changed = false
    if (!same) {
      const next = {
        ...manifest,
        name: manifest.name ?? `dsh-profile-${NODE_PROFILE}`,
        private: true,
        dependencies: manifest.dependencies ?? {},
        dsh: {
          ...(manifest.dsh ?? {}),
          profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles] },
        },
      }
      const encoded = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8').toString('base64')
      const write = await this.connection.exec({
        argv: ['sh', '-c', `mkdir -p ${REMOTE_LAYOUT.profile} && printf '%s' '${encoded}' | base64 -d > ${manifestPath}`],
        timeoutMs: 30_000,
      })
      if (write.code !== 0) {
        throw toSshError(new Error(`writing the profile manifest failed: ${(write.stderr || write.stdout).trim().slice(-400)}`))
      }
      changed = true
    }

    // Ensure the patch exists before the first launch: the host reads it as a layer,
    // and an absent file would simply mean "no configuration yet".
    const ensure = await this.connection.exec({
      argv: ['sh', '-c', `mkdir -p ${REMOTE_LAYOUT.profile} && [ -f ${REMOTE_LAYOUT.profilePatch} ] || printf '# owned by @local/dsh-fleet\\n[]\\n' > ${REMOTE_LAYOUT.profilePatch}`],
      timeoutMs: 15_000,
    })
    if (ensure.code !== 0) {
      throw toSshError(new Error(`preparing the node profile failed: ${(ensure.stderr || ensure.stdout).trim().slice(-400)}`))
    }

    const revertedPrevious = await this.#revertPreviousProfile(bundles)
    return { changed, revertedPrevious }
  }

  /**
   * Undo what earlier builds did to the upstream `web` profile.
   *
   * Earlier builds replaced that profile's bundle list with the brain composition and
   * launched with `--patch`. Two reasons to undo it: the node should not compose a
   * brain bundle on the moments something else starts `web`, and a `web` profile left
   * composing an empty list is worse than one the user never touched.
   *
   * Only the bundle list this plugin wrote is restored — the profile's own patch,
   * sessions and settings are the user's and are never touched.
   * @param {readonly string[]} ours - the bundle list this plugin composes.
   * @returns {Promise<boolean>} whether anything was reverted.
   */
  async #revertPreviousProfile(ours) {
    const manifestPath = `${REMOTE_LAYOUT.legacyProfile}/package.json`
    const read = await this.connection.exec({
      argv: ['sh', '-c', `cat ${manifestPath} 2>/dev/null || echo ''`],
      timeoutMs: 15_000,
    })
    if (read.stdout.trim() === '') return false
    /** @type {any} */
    let manifest
    try {
      manifest = JSON.parse(read.stdout)
    } catch {
      return false
    }
    const current = manifest?.dsh?.profile?.bundles
    // Only a list this plugin provably wrote is touched. An empty list is left alone:
    // it is broken enough that somebody will notice, and guessing that "empty means we
    // did it" would let this repair overwrite a deliberate choice.
    if (!Array.isArray(current) || !current.includes(ours.at(-1))) return false
    // Restore the shipped template rather than subtracting our names: an earlier
    // build replaced the whole list, so subtracting would leave `web` composing
    // nothing at all — a machine whose own web profile silently stopped working.
    const next = {
      ...manifest,
      dsh: { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...WEB_PROFILE_BUNDLES] } },
    }
    const encoded = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8').toString('base64')
    const write = await this.connection.exec({
      argv: ['sh', '-c', `printf '%s' '${encoded}' | base64 -d > ${manifestPath}`],
      timeoutMs: 30_000,
    })
    if (write.code !== 0) {
      throw toSshError(new Error(`reverting the previous profile failed: ${(write.stderr || write.stdout).trim().slice(-400)}`))
    }
    this.log('reverted the bundle list an earlier build wrote into profiles/web')
    return true
  }

  /**
   * Start the resident host unless one is already serving this version, then
   * read the port and launch token it printed.
   *
   * The launch line carries **no `--patch`**: configuration reaches the node through
   * its profile patch, which the running host hot-reloads. That is what lets a local
   * model or key change reach an already connected node without a restart — see
   * `docs/adr-0001`.
   * @param {object} [options]
   * @param {boolean} [options.force] - restart even when a host is alive.
   * @param {boolean} [options.bundleChanged] - restart because the brain bundle changed
   *   (module code has to be re-imported; only a restart does that).
   */
  async ensureServing(options = {}) {
    const existing = await this.status()
    const launchedByThisShape = existing !== undefined
      && existing.profile === NODE_PROFILE
      && existing.overlay !== true
      && existing.version === this.version
    if (existing !== undefined && !options.force && !options.bundleChanged
      && launchedByThisShape
      && await this.isAlive(existing.pid)) {
      this.serving = existing
      return existing
    }
    if (existing !== undefined) await this.stop()
    const script = `
set -eu
mkdir -p ${REMOTE_LAYOUT.run}
rm -f ${REMOTE_LAYOUT.log}
: > ${REMOTE_LAYOUT.log}
(cd ${REMOTE_LAYOUT.runtime} && setsid nohup node ${REMOTE_LAYOUT.cli} --profile ${NODE_PROFILE} --host 127.0.0.1 --port 0 --no-open >> ${REMOTE_LAYOUT.log} 2>&1 & echo $! > ${REMOTE_LAYOUT.run}/pid)
i=0
while [ "$i" -lt 120 ]; do
  if grep -q 'dsh web: http' ${REMOTE_LAYOUT.log} 2>/dev/null; then break; fi
  sleep 0.5
  i=$((i + 1))
done
cat ${REMOTE_LAYOUT.log}
`.trim()
    const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 5 * 60_000, maxBytes: 256 * 1024 })
    const parsed = parseWebUrl(result.stdout)
    if (parsed === undefined) {
      const tail = (result.stdout || result.stderr).trim().split('\n').slice(-12).join('\n')
      throw toSshError(new Error(`the resident host did not report a URL. Its log tail:\n${tail}`))
    }
    const pidResult = await this.connection.exec({
      argv: ['sh', '-c', `cat ${REMOTE_LAYOUT.run}/pid 2>/dev/null || echo 0`],
      timeoutMs: 15_000,
    })
    const pid = Number.parseInt(pidResult.stdout.trim(), 10) || 0
    // The record says which launch shape produced this host, so a host started by an
    // older build (a `web` profile or a `--patch` overlay) is replaced once instead of
    // being trusted to hot-reload a file it never read.
    const serving = {
      port: parsed.port,
      token: parsed.token,
      pid,
      version: this.version,
      profile: NODE_PROFILE,
      overlay: false,
    }
    await this.connection.exec({
      argv: ['sh', '-c', `printf '%s' '${JSON.stringify(serving).replaceAll("'", `'\\''`)}' > ${REMOTE_LAYOUT.status}`],
      timeoutMs: 15_000,
    })
    this.log(`resident host ready on ${String(parsed.port)} (pid ${String(pid)})`)
    this.serving = serving
    return serving
  }

  /** Stop the resident host if this plugin started one. */
  async stop() {
    const existing = await this.status()
    const script = existing === undefined
      ? `pkill -f 'dsh-fleet/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js' 2>/dev/null || true; rm -f ${REMOTE_LAYOUT.status}`
      : `
kill ${String(existing.pid)} 2>/dev/null || true
i=0
while [ "$i" -lt 20 ]; do
  kill -0 ${String(existing.pid)} 2>/dev/null || break
  sleep 0.25
  i=$((i + 1))
done
kill -9 ${String(existing.pid)} 2>/dev/null || true
rm -f ${REMOTE_LAYOUT.status}
`.trim()
    await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 60_000 })
    this.serving = undefined
  }

  /** Everything the settings page shows for one node. */
  async inspect() {
    const facts = await this.probe()
    const installed = facts.nodeUsable ? await this.installedVersion() : undefined
    const status = await this.status()
    const alive = status === undefined ? false : await this.isAlive(status.pid)
    return {
      facts,
      installedVersion: installed,
      needsInstall: installed !== this.version,
      serving: status !== undefined && alive ? status : undefined,
      versionMatches: installed === this.version,
    }
  }
}

/** Read `dsh web: http://127.0.0.1:<port>/?token=<token>` out of one log. */
export function parseWebUrl(text) {
  const match = /dsh web:\s+(https?:\/\/[^\s]+)/u.exec(text)
  if (match === null) return undefined
  try {
    const url = new URL(match[1])
    const token = url.searchParams.get('token') ?? ''
    const port = Number.parseInt(url.port, 10)
    if (!Number.isFinite(port) || token === '') return undefined
    return { port, token, origin: `${url.protocol}//${url.host}` }
  } catch {
    return undefined
  }
}

/** Categories that mean "this machine cannot host a resident DSH yet". */
export const PROVISION_FAILURES = Object.freeze({
  NO_NODE: 'no-node',
  OLD_NODE: 'old-node',
  NO_NPM: 'no-npm',
  INSTALL_FAILED: 'install-failed',
  START_FAILED: 'start-failed',
  AUTH: SSH_FAILURE.AUTH,
})
