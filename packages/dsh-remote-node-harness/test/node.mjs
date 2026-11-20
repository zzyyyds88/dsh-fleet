/**
 * The node the end-to-end tests talk to.
 *
 * There is deliberately **no default credential and no default address**: this is
 * a public repository, and a test that quietly falls back to somebody's LAN IP and
 * password is a test that leaks one. Configure it once and the node-backed tests
 * pick it up:
 *
 * ```bash
 * export RNH_TEST_HOST=192.0.2.10      # RFC 5737 documentation address
 * export RNH_TEST_PORT=22
 * export RNH_TEST_USER=root
 * export RNH_TEST_PASSWORD=...         # or RNH_TEST_KEY_FILE=<path>
 * ```
 *
 * @module @greatbaby/dsh-remote-node-harness/test/node
 */
import { readFileSync } from 'node:fs'
import { Client } from 'ssh2'

/** Environment variables a node-backed test needs. */
const REQUIRED = ['RNH_TEST_HOST', 'RNH_TEST_USER']

/**
 * The node configuration, read from the environment.
 * @returns {{ host: string, port: number, username: string, password?: string, privateKey?: string }}
 */
export function nodeConfig() {
  const missing = REQUIRED.filter(name => {
    const value = process.env[name]
    return value === undefined || value.length === 0
  })
  if (missing.length > 0) {
    throw new Error(
      `this test needs a real node: set ${missing.join(', ')} `
      + '(plus RNH_TEST_PASSWORD or RNH_TEST_KEY_FILE)',
    )
  }
  const keyFile = process.env.RNH_TEST_KEY_FILE
  const password = process.env.RNH_TEST_PASSWORD
  return {
    host: process.env.RNH_TEST_HOST,
    port: Number(process.env.RNH_TEST_PORT ?? 22),
    username: process.env.RNH_TEST_USER,
    ...(keyFile === undefined || keyFile.length === 0
      ? {}
      : { privateKey: readFileSync(keyFile, 'utf8') }),
    ...(password === undefined || password.length === 0 ? {} : { password }),
  }
}

/**
 * Run one command on the node, keeping its exit code and both streams.
 *
 * `nodeExec` returns stdout only, which is enough when the command is a query and a silence
 * means "no such file". It is **not** enough for a script: a shell that exits 3 having
 * printed its reason to stderr looks exactly like a shell that succeeded and printed
 * nothing, and the difference is the whole diagnosis.
 *
 * @param {string} command
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - close the channel after this long.
 * @param {ReturnType<typeof nodeConfig>} [options.config] - reuse a resolved config.
 * @returns {Promise<{ code: number | undefined, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function nodeRun(command, options = {}) {
  const client = new Client()
  const config = options.config ?? nodeConfig()
  await new Promise((resolve, reject) => {
    client.on('ready', resolve).on('error', reject).connect({ ...config, readyTimeout: 20_000 })
  })
  try {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error)
        const out = []
        const err = []
        let timedOut = false
        const timer = options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => { timedOut = true; stream.close() }, options.timeoutMs)
        stream.on('data', chunk => out.push(chunk))
        stream.stderr.on('data', chunk => err.push(chunk))
        stream.on('close', (code) => {
          if (timer !== undefined) clearTimeout(timer)
          resolve({
            code: typeof code === 'number' ? code : undefined,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
            timedOut,
          })
        })
      })
    })
  } finally {
    client.end()
  }
}

/**
 * Run one command on the node, bypassing DSH entirely, returning its stdout.
 *
 * The tests use this as an independent witness: the plugin says a file was written, and
 * this reads it over a separate connection to prove it. Use {@link nodeRun} when the exit
 * code or stderr matters.
 *
 * @param {string} command
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - close the channel after this long.
 * @param {ReturnType<typeof nodeConfig>} [options.config] - reuse a resolved config.
 * @returns {Promise<string>}
 */
export async function nodeExec(command, options = {}) {
  const result = await nodeRun(command, options)
  return result.stdout
}
