/**
 * Node registry: the durable list of remote machines this profile knows about.
 *
 * Stored under the plugin's own directory (`$DSH_HOME/fleet/nodes.json`) so a
 * remote node's data never mixes with local DSH sessions, credentials or
 * workspaces. Secrets never appear here — only the credential reference kind.
 *
 * @module @greatbaby/dsh-fleet/core/registry
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Absolute root of this plugin's own data. */
export function fleetHome() {
  return process.env.DSH_HOME === undefined
    ? join(homedir(), '.dsh', 'fleet')
    : join(process.env.DSH_HOME, 'fleet')
}

/**
 * One remote machine.
 * @typedef {object} NodeRecord
 * @property {string} id - stable local identity, `n` plus 12 hex characters.
 * @property {string} name - user-facing label.
 * @property {'ssh'} transport
 * @property {string} host
 * @property {number} port - SSH port.
 * @property {string} username
 * @property {{ kind: 'password' | 'key' | 'agent', secretRef?: string }} auth
 * @property {string} [jumpHost] - optional `host` or `user@host:port` jump target.
 * @property {string} [remoteRoot] - absolute install directory on the machine.
 * @property {boolean} enabled - whether opening the profile tries to connect.
 * @property {string} [lastError]
 * @property {number} [lastConnectedAt]
 * @property {number} [lastSeenVersion]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const ID_PATTERN = /^n[0-9a-f]{12}$/u

/** Mint one new node identity. */
export function newNodeId() {
  return `n${randomBytes(6).toString('hex')}`
}

/** Whether a string is a well-formed node identity. */
export function isNodeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** Validate and normalize one record read from disk or written by a client. */
export function normalizeNode(input) {
  if (typeof input !== 'object' || input === null) throw new Error('fleet: a node must be an object')
  const id = input.id
  if (!isNodeId(id)) throw new Error('fleet: node id must be "n" plus 12 hex characters')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > 120) throw new Error('fleet: node name must be 1-120 characters')
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (host.length === 0 || host.length > 255 || /\s/u.test(host)) throw new Error('fleet: node host is invalid')
  const port = Number(input.port ?? 22)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('fleet: node port must be 1-65535')
  const username = typeof input.username === 'string' ? input.username.trim() : ''
  if (username.length === 0 || username.length > 64) throw new Error('fleet: node username must be 1-64 characters')
  const authKind = input.auth?.kind ?? 'password'
  if (authKind !== 'password' && authKind !== 'key' && authKind !== 'agent') {
    throw new Error('fleet: node auth kind must be password, key, or agent')
  }
  const remoteRoot = typeof input.remoteRoot === 'string' && input.remoteRoot.trim().length > 0
    ? input.remoteRoot.trim()
    : '~/.dsh-fleet'
  return {
    id,
    name,
    transport: 'ssh',
    host,
    port,
    username,
    auth: { kind: authKind },
    ...(typeof input.jumpHost === 'string' && input.jumpHost.trim().length > 0
      ? { jumpHost: input.jumpHost.trim() }
      : {}),
    remoteRoot,
    enabled: input.enabled !== false,
    ...(typeof input.lastError === 'string' ? { lastError: input.lastError.slice(0, 500) } : {}),
    ...(Number.isFinite(input.lastConnectedAt) ? { lastConnectedAt: input.lastConnectedAt } : {}),
    ...(typeof input.lastSeenVersion === 'string' ? { lastSeenVersion: input.lastSeenVersion } : {}),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
  }
}

/** Durable node list with atomic whole-file publication. */
export class NodeRegistry {
  /** @type {NodeRecord[] | undefined} */
  #nodes
  #listeners = new Set()

  file() {
    return join(fleetHome(), 'nodes.json')
  }

  /** Read the list, loading it once. */
  list() {
    if (this.#nodes === undefined) this.#load()
    return this.#nodes.map(node => ({ ...node, auth: { ...node.auth } }))
  }

  /** Read one node. */
  get(id) {
    return this.list().find(node => node.id === id)
  }

  /** Whether a node exists. */
  has(id) {
    return this.list().some(node => node.id === id)
  }

  /** Insert or replace one node, then publish. A new node mints its own id. */
  put(input) {
    if (this.#nodes === undefined) this.#load()
    const next = normalizeNode({ ...input, id: input.id ?? newNodeId(), updatedAt: Date.now() })
    const index = this.#nodes.findIndex(node => node.id === next.id)
    if (index === -1) this.#nodes.push(next)
    else this.#nodes[index] = next
    this.#save()
    this.#publish()
    return { ...next }
  }

  /** Patch mutable label fields without touching connectivity facts. */
  rename(id, name) {
    const existing = this.get(id)
    if (existing === undefined) throw new Error(`fleet: no node ${id}`)
    return this.put({ ...existing, name })
  }

  /** Record the outcome of one connection attempt. */
  recordOutcome(id, outcome) {
    const existing = this.get(id)
    if (existing === undefined) return undefined
    const next = { ...existing }
    if (outcome.ok) {
      next.lastConnectedAt = Date.now()
      delete next.lastError
      if (typeof outcome.version === 'string') next.lastSeenVersion = outcome.version
    } else if (typeof outcome.error === 'string') {
      next.lastError = outcome.error.slice(0, 500)
    }
    return this.put(next)
  }

  /** Remove one node. */
  remove(id) {
    if (this.#nodes === undefined) this.#load()
    const before = this.#nodes.length
    this.#nodes = this.#nodes.filter(node => node.id !== id)
    if (this.#nodes.length === before) return false
    this.#save()
    this.#publish()
    return true
  }

  /** Subscribe to list changes; returns the unsubscribe. */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish() {
    const snapshot = this.list()
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A failing observer must never break the registry write.
      }
    }
  }

  #load() {
    let text
    try {
      text = readFileSync(this.file(), 'utf8')
    } catch {
      this.#nodes = []
      return
    }
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : parsed?.nodes
      this.#nodes = Array.isArray(list) ? list.map(normalizeNode) : []
    } catch {
      this.#nodes = []
    }
  }

  #save() {
    const directory = fleetHome()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = this.file()
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.#nodes ?? [], null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // A platform without POSIX modes keeps the file readable to its owner.
    }
  }
}
