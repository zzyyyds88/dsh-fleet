/**
 * The node the end-to-end tests talk to.
 *
 * There is deliberately **no default credential and no default address**: this is
 * a public repository, and a test that quietly falls back to somebody's LAN IP and
 * password is a test that leaks one. Configure it once and the four node-backed
 * tests pick it up:
 *
 * ```bash
 * export DSH_FLEET_TEST_HOST=192.0.2.10      # RFC 5737 documentation address
 * export DSH_FLEET_TEST_PORT=22
 * export DSH_FLEET_TEST_USER=root
 * export DSH_FLEET_TEST_PASSWORD=...         # or DSH_FLEET_TEST_KEY_FILE=<path>
 * ```
 *
 * @module @local/dsh-fleet/test/node
 */
import { readFileSync } from 'node:fs'
import { Client } from 'ssh2'

/** Environment variables a node-backed test needs. */
const REQUIRED = ['DSH_FLEET_TEST_HOST', 'DSH_FLEET_TEST_USER']

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
      + '(plus DSH_FLEET_TEST_PASSWORD or DSH_FLEET_TEST_KEY_FILE)',
    )
  }
  const keyFile = process.env.DSH_FLEET_TEST_KEY_FILE
  const password = process.env.DSH_FLEET_TEST_PASSWORD
  return {
    host: process.env.DSH_FLEET_TEST_HOST,
    port: Number(process.env.DSH_FLEET_TEST_PORT ?? 22),
    username: process.env.DSH_FLEET_TEST_USER,
    ...(keyFile === undefined || keyFile.length === 0
      ? {}
      : { privateKey: readFileSync(keyFile, 'utf8') }),
    ...(password === undefined || password.length === 0 ? {} : { password }),
  }
}

/**
 * Run one command on the node, bypassing DSH entirely.
 *
 * The tests use this as an independent witness: the plugin says a file was
 * written, and this reads it over a separate connection to prove it.
 * @param {string} command
 * @returns {Promise<string>}
 */
export async function nodeExec(command) {
  const client = new Client()
  await new Promise((resolve, reject) => {
    client.on('ready', resolve).on('error', reject).connect({ ...nodeConfig(), readyTimeout: 20_000 })
  })
  try {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error)
        const out = []
        stream.on('data', chunk => out.push(chunk))
        stream.on('close', () => resolve(Buffer.concat(out).toString('utf8')))
      })
    })
  } finally {
    client.end()
  }
}
