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
 * It is, however, a **separate DSH installation** with its own `~/.dsh`. That is
 * why it is started with `--patch <brain.patch.yml>`: the overlay carries this
 * Host's model rows and switches off the browser plugins a node cannot use. The
 * overlay is written by `host/provision.js` and passed in through `ensureServing`.
 *
 * @module @local/dsh-fleet/remote/daemon
 */
import { SSH_FAILURE, toSshError } from '../ssh/connection.js'

/** The Node major version the resident host needs. */
export const MINIMUM_NODE_MAJOR = 22

/** Files this plugin owns on a remote machine, relative to the node's root. */
export const REMOTE_LAYOUT = Object.freeze({
  root: '~/.dsh-fleet',
  runtime: '~/.dsh-fleet/runtime',
  run: '~/.dsh-fleet/run',
  log: '~/.dsh-fleet/run/host.log',
  status: '~/.dsh-fleet/run/status.json',
  patch: '~/.dsh-fleet/run/brain.patch.yml',
  packageJson: '~/.dsh-fleet/runtime/package.json',
  cli: '~/.dsh-fleet/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
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
   * Write the overlay the resident host starts with, and report whether it
   * changed.
   *
   * The file has to exist before `ensureServing` runs, and rewriting it on every
   * connect keeps a node in step with this Host's model roster. A restart is only
   * needed when the bytes actually differ, so a reconnect does not bounce a host
   * that is already correct.
   *
   * The payload travels base64-encoded: the overlay is YAML assembled from model
   * configuration, and a heredoc would break on any line that happened to match
   * the delimiter.
   * @param {string} text
   * @returns {Promise<{ changed: boolean }>}
   */
  async writePatch(text) {
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    const script = `
set -eu
mkdir -p ${REMOTE_LAYOUT.run}
target=${REMOTE_LAYOUT.patch}
tmp="$target.new"
printf '%s' '${encoded}' | base64 -d > "$tmp"
if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
  rm -f "$tmp"
  echo unchanged
else
  mv "$tmp" "$target"
  echo written
fi
`.trim()
    const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 60_000 })
    if (result.code !== 0) {
      throw toSshError(new Error(`writing the brain overlay failed: ${(result.stderr || result.stdout).trim().slice(-400)}`))
    }
    return { changed: result.stdout.includes('written') }
  }

  /**
   * Start the resident host unless one is already serving this version, then
   * read the port and launch token it printed.
   * @param {object} [options]
   * @param {boolean} [options.force] - restart even when a host is alive.
   * @param {boolean} [options.patchChanged] - restart because the overlay changed.
   */
  async ensureServing(options = {}) {
    const existing = await this.status()
    const patchApplied = existing !== undefined && existing.patch === true
    if (existing !== undefined && !options.force && !options.patchChanged
      && patchApplied && existing.version === this.version
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
(cd ${REMOTE_LAYOUT.runtime} && setsid nohup node ${REMOTE_LAYOUT.cli} --profile web --patch ${REMOTE_LAYOUT.patch} --host 127.0.0.1 --port 0 --no-open >> ${REMOTE_LAYOUT.log} 2>&1 & echo $! > ${REMOTE_LAYOUT.run}/pid)
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
    // `patch: true` records that this host was launched WITH the overlay. A host
    // started by an older build of this plugin has no such flag, so a reconnect
    // restarts it once instead of trusting a configuration it never loaded.
    const serving = { port: parsed.port, token: parsed.token, pid, version: this.version, patch: true }
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
