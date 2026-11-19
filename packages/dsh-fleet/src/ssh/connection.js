/**
 * SSH transport for one node: a pooled `ssh2` client that answers exec, SFTP and
 * direct-tcpip (port-forward) requests.
 *
 * The whole plugin talks to a node through this one connection. That is the
 * single most important difference from a per-operation SSH design: a remote
 * tool call must never pay a handshake, and a forwarded HTTP request must be
 * able to ride the connection that is already warm.
 *
 * @module @greatbaby/dsh-fleet/ssh/connection
 */
import { createHash } from 'node:crypto'
import { Client } from 'ssh2'

const READY_TIMEOUT_MS = 20_000
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3
const MAX_RETRIES = 3
const BASE_DELAY_MS = 400
/** Attempts to re-open a channel while the server's per-connection budget is full. */
const CHANNEL_RETRIES = 4
/** How long each wait grows: 250, 500, 750, 1000 ms. */
const CHANNEL_BACKOFF_MS = 250

/** Stable failure categories a caller can branch on without parsing text. */
export const SSH_FAILURE = Object.freeze({
  AUTH: 'auth',
  HOST_KEY: 'host-key',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  CLOSED: 'closed',
  /**
   * The server refused to open another channel on this connection.
   *
   * `sshd` limits **session** channels per connection (`MaxSessions`, default 10), and every
   * `exec` and every `direct-tcpip` forward is one. Measured on the reference node while one
   * long-lived session was held (the shape of `workspace/follow`):
   *
   *   5 concurrent execs → 5 ok
   *   8 concurrent execs → 8 ok
   *   10 concurrent execs → 8 ok, 2 refused (`Channel open failure: open failed`)
   *   12 concurrent execs → 8 ok, 4 refused
   *
   * So the ceiling is **real and reachable**: one long-lived session plus a burst of tool calls
   * or picker calls on the same node runs out of channels even though the connection is
   * healthy. The error is ssh2's `Channel open failure: open failed`, which classifies as
   * `unknown` unless it is named here — and an `unknown` failure is not retried, so it reached
   * the user as a bare "Unable to exec".
   */
  CHANNEL: 'channel',
  UNKNOWN: 'unknown',
})

/** Classify one ssh2 error into a stable category. */
export function classifySshError(error) {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (/all configured authentication methods failed|authentication|publickey|password|private key/u.test(text)) {
    return SSH_FAILURE.AUTH
  }
  if (/host key|hostkey|man-in-the-middle|fingerprint/u.test(text)) return SSH_FAILURE.HOST_KEY
  // Before the network rule, and before `unknown`: this is the server declining a channel,
  // not the network failing, and it is the one refusal that a retry can fix.
  if (/channel open failure|open failed|unable to exec|unable to open shell|channel is not open|administratively prohibited/u.test(text)) {
    return SSH_FAILURE.CHANNEL
  }
  if (/timed out|timeout|ready timeout/u.test(text)) return SSH_FAILURE.TIMEOUT
  if (/econnrefused|econnreset|enotfound|ehostunreach|enetunreach|connect|network|socket hang up/u.test(text)) {
    return SSH_FAILURE.NETWORK
  }
  if (/not connected|connection closed|no response from server/u.test(text)) return SSH_FAILURE.CLOSED
  return SSH_FAILURE.UNKNOWN
}

/** Wrap one error with its category and cause. */
export function toSshError(error, category = classifySshError(error)) {
  const message = error instanceof Error ? error.message : String(error)
  return Object.assign(new Error(message, { cause: error }), { category, sshCategory: category })
}

/**
 * True for categories worth retrying.
 *
 * `CHANNEL` belongs here for a different reason than the rest: the connection is fine, it is
 * the server's per-connection channel budget that ran out. The retry that helps is therefore
 * a short wait on the **same** connection (see `#openWithChannelBudget`), not a new handshake —
 * a new handshake would drop the long-lived streams that are part of the reason the budget is
 * tight, and losing a `workspace/follow` to open one `exec` is a worse trade than waiting.
 */
export function isRetryable(category) {
  return category === SSH_FAILURE.NETWORK || category === SSH_FAILURE.TIMEOUT
    || category === SSH_FAILURE.CLOSED || category === SSH_FAILURE.CHANNEL
}

/**
 * One lazily established, reusable SSH client.
 *
 * Every entry point awaits {@link client}, so a caller never sees a partial
 * connection, and a failed handshake rejects the waiters of that attempt
 * instead of parking them forever.
 */
export class SshConnection {
  /** @type {import('ssh2').Client | undefined} */
  #client
  /** @type {Promise<import('ssh2').Client> | undefined} */
  #pending
  /** @type {Promise<import('ssh2').SFTPWrapper> | undefined} */
  #sftp
  #closed = false
  /**
   * Clients this object ended itself, so their `close` event is not reported as a drop.
   *
   * A WeakSet rather than a flag on the client: ssh2 owns that object, and a property added
   * to it would be one more thing a future version could disagree about.
   * @type {WeakSet<import('ssh2').Client>}
   */
  #ending = new WeakSet()

  /**
   * @param {object} target
   * @param {string} target.host
   * @param {number} target.port
   * @param {string} target.username
   * @param {{ kind: 'password' | 'key' | 'agent', password?: string, privateKey?: string | Buffer, passphrase?: string }} target.auth
   * @param {string} [target.label] - diagnostic label for logs.
   * @param {string} [target.hostFingerprint] - the host key recorded for this machine; absent
   *   means first use.
   * @param {(fingerprint: string) => void} [target.onFirstFingerprint] - first key seen.
   * @param {(expected: string, actual: string) => void} [target.onFingerprintMismatch] - the key
   *   changed, which refuses the handshake.
   * @param {() => void} [target.onDrop] - the socket closed without this object asking.
   * @param {(message: string) => void} [target.log]
   */
  constructor(target) {
    this.target = target
  }

  /** The label used in diagnostics. */
  get label() {
    return this.target.label ?? `${this.target.username}@${this.target.host}:${String(this.target.port)}`
  }

  /** Whether this connection was disposed. */
  get closed() {
    return this.#closed
  }

  /** Whether a live client is already established. */
  get ready() {
    return this.#client !== undefined
  }

  /**
   * The live client, connecting on first use.
   * @returns {Promise<import('ssh2').Client>}
   */
  async client() {
    if (this.#closed) throw toSshError(new Error('ssh connection was closed'), SSH_FAILURE.CLOSED)
    if (this.#client !== undefined) return this.#client
    if (this.#pending !== undefined) return this.#pending
    this.#pending = this.#connectWithRetry()
    try {
      return await this.#pending
    } finally {
      this.#pending = undefined
    }
  }

  /**
   * The SFTP subsystem, opening it once.
   * @returns {Promise<import('ssh2').SFTPWrapper>}
   */
  async sftp() {
    if (this.#sftp !== undefined) return this.#sftp
    const opening = (async () => {
      const client = await this.client()
      return await new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) reject(toSshError(error))
          else resolve(sftp)
        })
      })
    })()
    this.#sftp = opening
    try {
      return await opening
    } catch (error) {
      this.#sftp = undefined
      throw error
    }
  }

  /**
   * Run one argv vector remotely and collect its output.
   *
   * `argv` never passes through a local shell: ssh2 sends the joined command to
   * the remote login shell, so the caller supplies already-safe tokens and this
   * method quotes each one for POSIX shells.
   * @param {object} request
   * @param {readonly string[]} request.argv - program and its arguments.
   * @param {string} [request.cwd] - absolute directory to run in.
   * @param {number} [request.timeoutMs] - ceiling for the whole transfer.
   * @param {string | Uint8Array} [request.stdin] - bytes written to the child.
   * @param {number} [request.maxBytes] - cap on each captured stream tail.
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{ code: number | null, signal: string | undefined, stdout: string, stderr: string, truncated: boolean }>}
   */
  async exec(request) {
    const command = posixCommand(request.argv, request.cwd)
    const maxBytes = request.maxBytes ?? 4 * 1024 * 1024
    const channel = await this.#openSession(command)
    return await new Promise((resolve, reject) => {
      const out = []
      const err = []
      let outBytes = 0
      let errBytes = 0
      let truncated = false
      const collect = (target, chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (target === out) {
          if (outBytes >= maxBytes) { truncated = true; return }
          const room = maxBytes - outBytes
          const slice = buffer.length <= room ? buffer : buffer.subarray(0, room)
          if (slice.length !== buffer.length) truncated = true
          out.push(slice)
          outBytes += slice.length
        } else {
          if (errBytes >= maxBytes) { truncated = true; return }
          const room = maxBytes - errBytes
          const slice = buffer.length <= room ? buffer : buffer.subarray(0, room)
          if (slice.length !== buffer.length) truncated = true
          err.push(slice)
          errBytes += slice.length
        }
      }
      let timer
      const abort = () => {
        try { channel.signal('KILL') } catch { /* the channel may already be gone */ }
        try { channel.close() } catch { /* idempotent */ }
        finish(toSshError(new Error('ssh exec was aborted'), SSH_FAILURE.CLOSED))
      }
      const finish = (failure) => {
        if (timer !== undefined) clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        if (failure !== undefined) reject(failure)
      }
      channel.on('data', chunk => { collect(out, chunk) })
      channel.stderr.on('data', chunk => { collect(err, chunk) })
      channel.on('exit', (code, signal) => { channel.__exit = { code, signal } })
      channel.on('close', (code, signal) => {
        const exit = channel.__exit ?? { code, signal }
        finish()
        resolve({
          code: exit.code ?? code ?? null,
          signal: exit.signal ?? signal ?? undefined,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          truncated,
        })
      })
      channel.on('error', error => {
        finish(toSshError(error))
        reject(toSshError(error))
      })
      if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
        timer = setTimeout(() => {
          try { channel.signal('KILL') } catch { /* best effort */ }
          try { channel.close() } catch { /* idempotent */ }
          finish(toSshError(new Error(`ssh exec timed out after ${String(request.timeoutMs)}ms`), SSH_FAILURE.TIMEOUT))
        }, request.timeoutMs)
      }
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted === true) {
        abort()
        return
      }
      if (request.stdin !== undefined) channel.end(request.stdin)
      else channel.end()
    })
  }

  /**
   * Open one session channel, waiting out a full channel budget instead of failing.
   *
   * The ceiling is `MaxSessions` (default 10) per **connection**, and this Host holds
   * long-lived channels: one per `workspace/follow`, one per terminal, one per forwarded HTTP
   * exchange in flight. A burst therefore hits the ceiling on a connection that is perfectly
   * healthy, and ssh2 reports it as `Channel open failure: open failed`.
   *
   * Two decisions, both measured:
   *
   * - **Wait and retry, rather than re-handshake.** Dropping the client would free the budget,
   *   but it would also kill every stream riding that connection — losing a node's workspace
   *   feed to open one `mkdir` is a worse trade than a few hundred milliseconds of waiting.
   * - **Retry a bounded number of times with a short backoff.** A channel frees up as soon as
   *   any in-flight exec finishes, so the wait is bounded in practice. After the last attempt
   *   the refusal is reported as `CHANNEL`, which the connect ladder treats as retryable and
   *   the settings page renders as "the node is busy" rather than an unexplained failure.
   *
   * @param {string} command
   * @returns {Promise<import('ssh2').Channel>}
   */
  async #openSession(command) {
    let lastError
    for (let attempt = 0; attempt <= CHANNEL_RETRIES; attempt += 1) {
      const client = await this.client()
      try {
        return await new Promise((resolve, reject) => {
          client.exec(command, (error, opened) => {
            if (error) reject(toSshError(error))
            else resolve(opened)
          })
        })
      } catch (error) {
        lastError = error
        if (error?.sshCategory !== SSH_FAILURE.CHANNEL || attempt === CHANNEL_RETRIES) throw error
        this.target.log?.(
          `ssh: the server's channel budget is full (${error.message}); `
          + `waiting ${String(CHANNEL_BACKOFF_MS)}ms before attempt ${String(attempt + 2)}`,
        )
        await new Promise(resolve => setTimeout(resolve, CHANNEL_BACKOFF_MS * (attempt + 1)))
      }
    }
    throw lastError
  }

  /**
   * Open one direct-tcpip channel to an address reachable from the remote host.
   * @param {string} host - destination as seen from the remote machine.
   * @param {number} port
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ stream: import('node:stream').Duplex, close: () => void }>}
   */
  async forwardOut(host, port, signal) {
    signal?.throwIfAborted()
    let stream
    for (let attempt = 0; attempt <= CHANNEL_RETRIES; attempt += 1) {
      const client = await this.client()
      try {
        stream = await new Promise((resolve, reject) => {
          client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
            if (error) reject(toSshError(error))
            else resolve(channel)
          })
        })
        break
      } catch (error) {
        // A forwarded channel is a channel: the same ceiling, the same wait.
        if (error?.sshCategory !== SSH_FAILURE.CHANNEL || attempt === CHANNEL_RETRIES) throw error
        await new Promise(resolve => setTimeout(resolve, CHANNEL_BACKOFF_MS * (attempt + 1)))
      }
    }
    return {
      stream,
      close: () => {
        try { stream.destroy() } catch { /* idempotent */ }
      },
    }
  }

  /** Release the client and every borrowed channel. */
  dispose() {
    this.#closed = true
    this.#sftp = undefined
    const client = this.#client
    this.#client = undefined
    if (client !== undefined) {
      this.#ending.add(client)
      try { client.end() } catch { /* already gone */ }
    }
  }

  /** Drop a dead client so the next call performs a fresh handshake. */
  invalidate() {
    const client = this.#client
    this.#client = undefined
    this.#sftp = undefined
    if (client !== undefined) {
      this.#ending.add(client)
      try { client.end() } catch { /* already gone */ }
    }
  }

  async #connectWithRetry() {
    let lastError
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (this.#closed) throw toSshError(new Error('ssh connection was closed'), SSH_FAILURE.CLOSED)
      try {
        const client = await this.#connectOnce()
        this.#client = client
        return client
      } catch (error) {
        lastError = error
        const category = error?.category ?? classifySshError(error)
        if (!isRetryable(category) || attempt === MAX_RETRIES) throw toSshError(error, category)
        await new Promise(resolve => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt))
      }
    }
    throw toSshError(lastError)
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const settle = (fn) => {
        if (settled) return
        settled = true
        fn()
      }
      client.once('ready', () => {
        settle(() => {
          client.once('close', () => {
            if (this.#client !== client) return
            this.#client = undefined
            this.#sftp = undefined
            // A close this object did not ask for is a **drop**, and the node has to learn
            // about it: until now `state` stayed `connected` after the socket died, so the
            // sidebar kept listing workspaces that could not be opened and the card showed a
            // green dot. `invalidate()`/`dispose()` mark the client as deliberately ended, so
            // an ordinary disconnect never reports a drop.
            if (!this.#ending.has(client)) this.target.onDrop?.()
          })
          client.once('error', () => {
            if (this.#client !== client) return
            this.#client = undefined
            this.#sftp = undefined
          })
          resolve(client)
        })
      })
      client.on('error', error => {
        try { client.end() } catch { /* already gone */ }
        settle(() => reject(toSshError(error)))
      })
      client.connect(this.#connectConfig())
    })
  }

  #connectConfig() {
    const { host, port, username, auth } = this.target
    /** @type {import('ssh2').ConnectConfig} */
    const config = {
      host,
      port,
      username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      // The fence a browser deployment gets from a signed cookie, a node gets
      // from the SSH host key: record the first key seen per host:port and
      // refuse a silent change. `undefined` in target.hostFingerprint means this
      // node has never been verified — that is **first use**, not a failure, so the
      // key is recorded and the handshake proceeds. Every later handshake compares.
      hostVerifier: (key, verify) => {
        const fingerprint = fingerprintOf(key)
        const expected = this.target.hostFingerprint
        if (expected === undefined) {
          this.target.onFirstFingerprint?.(fingerprint)
          verify(true)
          return
        }
        const accepted = fingerprint === expected
        if (!accepted) this.target.onFingerprintMismatch?.(expected, fingerprint)
        verify(accepted)
      },
    }
    if (auth.kind === 'password') {
      if (typeof auth.password !== 'string' || auth.password.length === 0) {
        throw toSshError(new Error('this node has no stored password'), SSH_FAILURE.AUTH)
      }
      config.password = auth.password
    } else if (auth.kind === 'key') {
      if (auth.privateKey === undefined) {
        throw toSshError(new Error('this node has no stored private key'), SSH_FAILURE.AUTH)
      }
      config.privateKey = auth.privateKey
      if (typeof auth.passphrase === 'string' && auth.passphrase.length > 0) config.passphrase = auth.passphrase
    } else {
      config.agent = process.env.SSH_AUTH_SOCK ?? undefined
      if (config.agent === undefined) {
        throw toSshError(new Error('SSH_AUTH_SOCK is not set, so an agent-authenticated node cannot connect'), SSH_FAILURE.AUTH)
      }
    }
    return config
  }
}

/** sha256 of the host key in OpenSSH's colon-separated hex form. */
export function fingerprintOf(key) {
  const digest = createHash('sha256').update(key).digest('hex')
  return digest.match(/.{2}/gu)?.join(':') ?? digest
}

/**
 * Join one argv vector into a POSIX command line, quoting every token.
 * @param {readonly string[]} argv
 * @param {string} [cwd]
 */
export function posixCommand(argv, cwd) {
  if (argv.length === 0) throw new Error('fleet: an exec needs at least one argv element')
  const quoted = argv.map(quotePosixArgument).join(' ')
  return cwd === undefined ? quoted : `cd ${quotePosixArgument(cwd)} && exec ${quoted}`
}

/** Quote one token for a POSIX shell. */
export function quotePosixArgument(value) {
  if (value.length === 0) return "''"
  if (/^[\w@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}
