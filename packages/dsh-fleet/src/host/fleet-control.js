/**
 * The narrow surface a "node control" agent session is allowed to act on.
 *
 * A Remote caller driving this Host can only route what a Service exposes, and until
 * now the fleet had no Service at all: the node list lived behind `/fleet/api`, an HTTP
 * surface the settings page uses and a tool has no business reaching for. This module
 * turns the same registry into one Cordis service so a tool can be registered against
 * it — and, just as importantly, so the *set* of things an agent can do is declared in
 * one place rather than inferred from whatever endpoints happen to exist.
 *
 * Secrets never cross this boundary. `add` accepts a reference — a private-key path on
 * this machine, or the name of an environment variable — and reads it here; the value
 * goes straight into the credential store and never appears in a result. A tool's
 * arguments are recorded verbatim in the session log, so accepting a pasted password
 * would mean writing it to disk.
 *
 * @module @local/dsh-fleet/host/fleet-control
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Expand a leading `~` so a key path can be written the way a person writes it. */
function expandHome(path) {
  const text = path.trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Read one authentication secret from a reference the caller named.
 *
 * Only two sources exist on purpose: a file this machine already has, and an
 * environment variable this machine already sets. Both keep the secret out of the
 * conversation, which is the only place a tool argument goes.
 *
 * @param {{ kind?: string, path?: string, env?: string } | undefined} auth
 * @param {(name: string) => string | undefined} environment
 * @returns {{ kind: 'key' | 'password' | 'agent', privateKey?: string, password?: string }}
 */
export function readAuthReference(auth, environment = name => process.env[name]) {
  const kind = typeof auth?.kind === 'string' ? auth.kind : 'agent'
  if (kind === 'agent') return { kind: 'agent' }
  if (kind === 'key') {
    const raw = typeof auth.path === 'string' ? auth.path.trim() : ''
    if (raw.length === 0) {
      throw Object.assign(
        new Error('a key reference needs `path`: the location of a private-key file on this machine'),
        { code: 'auth-reference-invalid' },
      )
    }
    const path = resolve(expandHome(raw))
    if (!isAbsolute(path)) {
      throw Object.assign(new Error(`${raw} is not an absolute path`), { code: 'auth-reference-invalid' })
    }
    let privateKey
    try {
      privateKey = readFileSync(path, 'utf8')
    } catch (error) {
      throw Object.assign(
        new Error(`this machine cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`),
        { code: 'auth-reference-unreadable' },
      )
    }
    if (!privateKey.includes('PRIVATE KEY')) {
      throw Object.assign(new Error(`${path} does not look like an OpenSSH private key`), { code: 'auth-reference-invalid' })
    }
    // The path is not echoed back either: it names a file whose contents are a secret.
    return { kind: 'key', privateKey }
  }
  if (kind === 'password') {
    const name = typeof auth.env === 'string' ? auth.env.trim() : ''
    if (name.length === 0) {
      throw Object.assign(
        new Error('a password reference needs `env`: the name of an environment variable on this machine'),
        { code: 'auth-reference-invalid' },
      )
    }
    const value = environment(name)
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error(`this machine sets no ${name}`), { code: 'auth-reference-missing' })
    }
    return { kind: 'password', password: value }
  }
  throw Object.assign(new Error(`unknown authentication kind ${kind}`), { code: 'auth-reference-invalid' })
}

/**
 * Whether one value is a usable node identity.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNodeId(value) {
  return typeof value === 'string' && /^n[0-9a-f]{12}$/u.test(value)
}

/**
 * One node as a tool result carries it.
 *
 * Written against the object `NodeRuntime.describe()` returns rather than the runtime,
 * so the two callers — a live runtime and the snapshot `fleet.connect` already took —
 * produce the same shape. No field here can hold authentication material: the record's
 * `auth` is a kind, and the secret lives in the credential store.
 *
 * @param {Record<string, unknown>} described
 * @returns {Record<string, unknown>}
 */
function shapeNode(described) {
  return {
    id: described.id,
    name: described.name,
    host: described.host,
    port: described.port,
    username: described.username,
    authKind: described.authKind,
    credentialsReady: described.credentialsReady === true,
    enabled: described.enabled !== false,
    remoteRoot: described.remoteRoot,
    state: described.state,
    ...(typeof described.error === 'string' ? { error: described.error } : {}),
    ...(described.remote === null || typeof described.remote !== 'object' ? {} : { remote: described.remote }),
  }
}

/**
 * What a node-control agent may do, in one object.
 *
 * Each method answers with plain JSON — no service instances, no secrets — because the
 * caller is a tool whose result is serialised into the conversation.
 */
export class FleetControl {
  /**
   * @param {object} options
   * @param {import('./fleet.js').Fleet} options.fleet
   * @param {(message: string) => void} [options.log]
   * @param {(name: string) => string | undefined} [options.environment] - injectable so a test need not touch `process.env`.
   */
  constructor(options) {
    this.fleet = options.fleet
    this.log = options.log ?? (() => {})
    this.environment = options.environment ?? (name => process.env[name])
  }

  /** Every recorded node with its live state. */
  list() {
    return this.fleet.list().map(runtime => shapeNode(runtime.describe()))
  }

  /**
   * Add one node. A secret referenced by the caller is read here and written to the
   * credential store; it is never returned, logged or echoed.
   *
   * @param {{ name?: string, host?: string, port?: number, username?: string, remoteRoot?: string, enabled?: boolean, auth?: object }} input
   * @returns {Promise<{ node: Record<string, unknown>, notes: string[] }>}
   */
  async add(input) {
    const notes = []
    if (input?.auth !== undefined && typeof input.auth === 'object') {
      const pasted = Reflect.get(input.auth, 'password') ?? Reflect.get(input.auth, 'privateKey')
      if (pasted !== undefined) {
        throw Object.assign(
          new Error('a credential cannot be passed inline: tool arguments are written to the session log. '
            + 'Use {"kind":"key","path":"~/.ssh/id_ed25519"} or {"kind":"password","env":"NAME"}, '
            + 'or have the user enter it in Settings > Remote nodes.'),
          { code: 'auth-inline-refused' },
        )
      }
    }
    const secret = readAuthReference(input?.auth, this.environment)
    const runtime = await this.fleet.put({
      name: input?.name,
      host: input?.host,
      port: input?.port,
      username: input?.username,
      ...(typeof input?.remoteRoot === 'string' ? { remoteRoot: input.remoteRoot } : {}),
      ...(input?.enabled === false ? { enabled: false } : {}),
      auth: { kind: secret.kind },
      ...(secret.kind === 'key' ? { privateKey: secret.privateKey } : {}),
      ...(secret.kind === 'password' ? { password: secret.password } : {}),
    })
    if (secret.kind === 'agent') {
      notes.push(`no credential was supplied: ${runtime.record.name} will authenticate through this machine's SSH agent, `
        + 'which must be running and hold a key for that host')
    }
    this.log(`fleet control: added ${runtime.record.name} (${runtime.record.host})`)
    return { node: shapeNode(runtime.describe()), notes }
  }

  /**
   * Change the non-secret fields of one node.
   * @param {string} id
   * @param {{ name?: string, host?: string, port?: number, username?: string, remoteRoot?: string, enabled?: boolean }} patch
   * @returns {Promise<{ node: Record<string, unknown>, notes: string[] }>}
   */
  async update(id, patch) {
    const runtime = this.#require(id)
    // Written through `put` so the record is re-validated: a host that is not a host must
    // fail here rather than at the next connect.
    const updated = await this.fleet.put({
      ...runtime.record,
      ...(typeof patch?.name === 'string' ? { name: patch.name } : {}),
      ...(typeof patch?.host === 'string' ? { host: patch.host } : {}),
      ...(typeof patch?.port === 'number' ? { port: patch.port } : {}),
      ...(typeof patch?.username === 'string' ? { username: patch.username } : {}),
      ...(typeof patch?.remoteRoot === 'string' ? { remoteRoot: patch.remoteRoot } : {}),
      ...(typeof patch?.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
    })
    const notes = []
    if (updated.state === 'connected') notes.push('this node is connected; disconnect and reconnect for the change to take effect')
    return { node: shapeNode(updated.describe()), notes }
  }

  /**
   * Forget one node and everything it owns, including its stored credential.
   * @param {string} id
   * @returns {Promise<{ removed: boolean, id: string }>}
   */
  async remove(id) {
    this.#require(id)
    const removed = await this.fleet.remove(id)
    this.log(`fleet control: removed ${id}`)
    return { removed, id }
  }

  /**
   * Connect one node and report the outcome, including the reason the node gave.
   *
   * Unlike the settings page this does not answer 202 and poll: an agent was asked
   * "connect it", and a reply of "started" would be a non-answer.
   *
   * @param {string} id
   * @returns {Promise<{ node: Record<string, unknown> }>}
   */
  async connect(id) {
    const described = await this.fleet.connect(this.#require(id))
    return { node: shapeNode(described) }
  }

  /**
   * Disconnect one node, leaving its record in place.
   * @param {string} id
   * @returns {Promise<{ node: Record<string, unknown> }>}
   */
  async disconnect(id) {
    const runtime = this.#require(id)
    await this.fleet.disconnect(runtime)
    return { node: shapeNode(runtime.describe()) }
  }

  /**
   * One node's current state.
   * @param {string} id
   * @returns {{ node: Record<string, unknown> }}
   */
  status(id) {
    return { node: shapeNode(this.#require(id).describe()) }
  }

  /** Resolve one identity or explain which part of it is wrong. */
  #require(id) {
    if (!isNodeId(id)) {
      throw Object.assign(
        new Error(`${String(id)} is not a node identity (it is "n" plus 12 hex characters)`),
        { code: 'node-id-invalid' },
      )
    }
    const runtime = this.fleet.get(id)
    if (runtime === undefined) {
      throw Object.assign(new Error(`no node ${id} is recorded on this machine`), { code: 'node-unknown' })
    }
    return runtime
  }
}

/**
 * Mount the service on a Cordis context.
 *
 * `ctx.provide` registers a fiber-owned effect and returns its disposer, so unloading
 * this plugin removes the service rather than leaving a handle to a disposed fleet
 * behind. It is wrapped here only so a second unload cannot double-release.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {FleetControl} control
 * @returns {() => void}
 */
export function provideFleetControl(ctx, control) {
  const dispose = ctx.provide('fleetControl', control)
  return () => {
    try { dispose() } catch { /* already released */ }
  }
}
