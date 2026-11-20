/**
 * Secret custody for node credentials.
 *
 * A node record never carries a password or a private key: `nodes.json` is a
 * plain file, and a plain file is the wrong place for a secret. The record
 * names the authentication *kind*; the value lives in the Host's credential
 * service under a key owned by this plugin, so it is written through the same
 * durable, permission-guarded store the rest of the application uses.
 *
 * @module @greatbaby/dsh-remote-node-harness/core/secrets
 */

/** Provider name this plugin registers its credential records under. */
const SCOPE = 'dsh-remote-node-harness'

/** Marker written into every record so a future format change is detectable. */
const RECORD_VERSION = 1

/** One credential record key for a node. */
function recordKeyFor(id) {
  return `dsh-remote-node-harness/n${id.replace(/^n/u, '')}`
}

/**
 * Read and write node secrets through `ctx.credentials`.
 *
 * The service's record API is a serialized read-modify-write, which is what
 * makes "replace the password, keep the key" safe without a second lock.
 */
export class SecretStore {
  /**
   * @param {{ readRecord: Function, modifyRecord: Function, deleteRecord: Function }} credentials
   */
  constructor(credentials) {
    this.credentials = credentials
  }

  /**
   * The stored secret for one node, or `undefined` while none is stored.
   * @param {string} id
   * @returns {Promise<{ kind: 'password' | 'key' | 'agent', password?: string, privateKey?: string, passphrase?: string } | undefined>}
   */
  async read(id) {
    const record = await this.credentials.readRecord(recordKeyFor(id))
    if (record === undefined || record.kind !== 'grant') return undefined
    const payload = record.payload
    if (typeof payload !== 'object' || payload === null || payload.version !== RECORD_VERSION) return undefined
    if (payload.kind !== 'password' && payload.kind !== 'key' && payload.kind !== 'agent') return undefined
    return {
      kind: payload.kind,
      ...(typeof payload.password === 'string' ? { password: payload.password } : {}),
      ...(typeof payload.privateKey === 'string' ? { privateKey: payload.privateKey } : {}),
      ...(typeof payload.passphrase === 'string' ? { passphrase: payload.passphrase } : {}),
    }
  }

  /**
   * Replace one node's secret. An empty value removes it, which is how "switch
   * from a password to a key" clears the field it no longer needs.
   * @param {string} id
   * @param {{ kind: 'password' | 'key' | 'agent', password?: string, privateKey?: string, passphrase?: string }} secret
   */
  async write(id, secret) {
    const payload = {
      version: RECORD_VERSION,
      kind: secret.kind,
      ...(typeof secret.password === 'string' && secret.password.length > 0
        ? { password: secret.password }
        : {}),
      ...(typeof secret.privateKey === 'string' && secret.privateKey.length > 0
        ? { privateKey: secret.privateKey }
        : {}),
      ...(typeof secret.passphrase === 'string' && secret.passphrase.length > 0
        ? { passphrase: secret.passphrase }
        : {}),
    }
    const hasValue = Object.keys(payload).length > 2
    if (!hasValue) {
      await this.credentials.deleteRecord(recordKeyFor(id))
      return
    }
    await this.credentials.modifyRecord(recordKeyFor(id), async () => ({ kind: 'grant', payload }))
  }

  /** Forget one node's secret. */
  async clear(id) {
    await this.credentials.deleteRecord(recordKeyFor(id))
  }

  /** Whether a usable secret is stored, without reading it. */
  async describe(id) {
    const info = await this.credentials.describeRecord(recordKeyFor(id))
    return { configured: info?.present === true }
  }
}

/** Convert one stored secret into the auth spec `SshConnection` accepts. */
export function authFromSecret(secret) {
  if (secret === undefined) return undefined
  if (secret.kind === 'password') {
    return secret.password === undefined ? undefined : { kind: 'password', password: secret.password }
  }
  if (secret.kind === 'key') {
    return secret.privateKey === undefined
      ? undefined
      : { kind: 'key', privateKey: secret.privateKey, passphrase: secret.passphrase }
  }
  return { kind: 'agent' }
}
