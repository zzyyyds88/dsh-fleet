/**
 * The fleet: every configured node, its warm SSH connection, its resident Host,
 * and the gateway the routing layer calls.
 *
 * This is the single owner of live node state. The HTTP management API, the
 * routing decorators and the settings surface all read nodes from here, so a
 * connection started by one path is visible to the others without a second
 * bookkeeping channel.
 *
 * @module @local/dsh-fleet/host/fleet
 */
import { NodeRegistry } from '../core/registry.js'
import { SecretStore, authFromSecret } from '../core/secrets.js'
import { SshConnection } from '../ssh/connection.js'
import { RemoteHost } from '../remote/daemon.js'
import { Provisioner } from './provision.js'
import { RemoteGateway } from './remote-gateway.js'
/** Connection lifecycle of one node, as a settings surface shows it. */
export const NODE_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
})

/** One live node: SSH connection, resident Host, and gateway. */
export class NodeRuntime {
  /**
   * @param {import('../core/registry.js').NodeRecord} record
   * @param {{ log: (message: string) => void, version: string }} options
   */
  constructor(record, options) {
    this.record = record
    this.log = options.log
    this.version = options.version
    this.state = NODE_STATE.IDLE
    this.phase = undefined
    this.error = undefined
    this.facts = undefined
    /** @type {{ port: number, token: string, pid: number, version: string } | undefined} */
    this.serving = undefined
    this.queue = Promise.resolve()
    /** @type {{ kind: 'password' | 'key' | 'agent', password?: string, privateKey?: string, passphrase?: string } | undefined} */
    this.secret = undefined
    /** What provisioning put on the node, for the settings surface. */
    this.provision = undefined
    this.connection = new SshConnection({
      host: record.host,
      port: record.port,
      username: record.username,
      auth: { kind: record.auth.kind },
      label: record.name,
    })
    this.host = new RemoteHost({
      connection: this.connection,
      version: this.version,
      log: message => this.log(`[${record.name}] ${message}`),
    })
    this.gateway = new RemoteGateway({
      connection: this.connection,
      serving: () => this.serving,
      log: message => this.log(`[${record.name}] ${message}`),
    })
  }

  /** Whether the node can answer routing calls right now. */
  get routable() {
    return this.state === NODE_STATE.CONNECTED && this.serving !== undefined
  }

  /** Adopt a freshly read secret, rebuilding the SSH client when it changes. */
  adopt(secret) {
    this.secret = secret
    const auth = authFromSecret(secret)
    if (auth === undefined) {
      this.connection.target.auth = { kind: this.record.auth.kind }
      return
    }
    this.connection.target.auth = auth
    this.connection.target.host = this.record.host
    this.connection.target.port = this.record.port
    this.connection.target.username = this.record.username
    this.connection.target.label = this.record.name
    this.gateway.reset()
    if (this.connection.ready) this.connection.invalidate()
  }

  /** Whether the stored secret is enough to attempt a connection. */
  credentialsReady() {
    const auth = authFromSecret(this.secret)
    if (auth === undefined) return false
    if (auth.kind === 'agent') return true
    if (auth.kind === 'password') return typeof auth.password === 'string' && auth.password.length > 0
    return auth.privateKey !== undefined
  }

  /** Snapshot for the management surface. */
  describe() {
    return {
      id: this.record.id,
      name: this.record.name,
      host: this.record.host,
      port: this.record.port,
      username: this.record.username,
      authKind: this.record.auth.kind,
      credentialsReady: this.credentialsReady(),
      enabled: this.record.enabled,
      remoteRoot: this.record.remoteRoot,
      state: this.state,
      ...(this.phase === undefined ? {} : { phase: this.phase }),
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.facts === undefined ? {} : { remote: this.facts }),
      ...(this.serving === undefined
        ? {}
        : { serving: { port: this.serving.port, version: this.serving.version } }),
      ...(this.provision === undefined ? {} : { provision: this.provision }),
      ...(this.record.lastConnectedAt === undefined ? {} : { lastConnectedAt: this.record.lastConnectedAt }),
      ...(this.record.lastSeenVersion === undefined ? {} : { lastSeenVersion: this.record.lastSeenVersion }),
    }
  }
}

/** Every node this profile knows, with its live connection when it has one. */
export class Fleet {
  /**
   * @param {object} options
   * @param {object} options.credentials - `ctx.credentials`
   * @param {string} options.version - the DSH version this profile runs.
   * @param {() => object | undefined} [options.configEditor] - the live config editor, for provisioning.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.log = options.log ?? (() => {})
    this.version = options.version
    this.configEditor = options.configEditor ?? (() => undefined)
    this.credentials = options.credentials
    this.registry = new NodeRegistry()
    this.secrets = new SecretStore({
      readRecord: key => options.credentials.readRecord(key),
      modifyRecord: (key, mutate) => options.credentials.modifyRecord(key, mutate),
      deleteRecord: key => options.credentials.deleteRecord(key),
      describeRecord: key => options.credentials.describeRecord(key),
    })
    /** @type {Map<string, NodeRuntime>} */
    this.runtimes = new Map()
    /** @type {Set<(nodes: NodeRuntime[]) => void>} */
    this.listeners = new Set()
  }

  /** Every runtime, creating one per stored record. */
  list() {
    const nodes = []
    for (const record of this.registry.list()) {
      const runtime = this.#runtimeOf(record)
      runtime.record = record
      nodes.push(runtime)
    }
    return nodes
  }

  /** One runtime by node identity. */
  get(id) {
    const record = this.registry.get(id)
    if (record === undefined) return undefined
    const runtime = this.#runtimeOf(record)
    runtime.record = record
    return runtime
  }

  /** Every node that can answer a routing call right now. */
  routable() {
    return this.list().filter(runtime => runtime.routable)
  }

  /** Subscribe to lifecycle changes. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Write one node record and adopt whatever secret came with it. */
  async put(input) {
    const record = this.registry.put(input)
    const runtime = this.#runtimeOf(record)
    runtime.record = record
    if (typeof input.password === 'string' || typeof input.privateKey === 'string'
      || typeof input.passphrase === 'string') {
      await this.secrets.write(record.id, {
        kind: record.auth.kind,
        ...(typeof input.password === 'string' ? { password: input.password } : {}),
        ...(typeof input.privateKey === 'string' ? { privateKey: input.privateKey } : {}),
        ...(typeof input.passphrase === 'string' ? { passphrase: input.passphrase } : {}),
      })
      runtime.connection.invalidate()
    }
    await this.#adoptSecret(runtime)
    this.#publish()
    return runtime
  }

  /** Forget one node and everything it owns. */
  async remove(id) {
    const runtime = this.runtimes.get(id)
    if (runtime !== undefined) {
      await this.disconnect(runtime).catch(() => undefined)
      this.runtimes.delete(id)
    }
    await this.secrets.clear(id).catch(() => undefined)
    const removed = this.registry.remove(id)
    this.#publish()
    return removed
  }

  /** Serialize every lifecycle action for one node. */
  serial(runtime, action) {
    const next = runtime.queue.then(action, action)
    runtime.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Bring one node up: SSH, probe, install when the version differs, start the
   * resident host, then prove the gateway answers before reporting success.
   * @param {NodeRuntime} runtime
   * @param {{ force?: boolean }} [options]
   */
  async connect(runtime, options = {}) {
    return await this.serial(runtime, async () => {
      if (runtime.state === NODE_STATE.CONNECTED && runtime.serving !== undefined && options.force !== true) {
        return runtime.describe()
      }
      runtime.state = NODE_STATE.CONNECTING
      runtime.error = undefined
      this.#publish()
      try {
        await this.#adoptSecret(runtime)
        if (!runtime.credentialsReady()) {
          throw new Error('this node has no stored credential; add its password or private key first')
        }
        runtime.phase = 'probe'
        this.#publish()
        runtime.facts = await runtime.host.probe()
        if (!runtime.facts.nodeUsable) {
          throw new Error(
            `this machine runs Node ${runtime.facts.nodeVersion || '(none)'}, `
            + 'but the resident host needs Node 22 or newer',
          )
        }
        runtime.phase = 'install'
        this.#publish()
        const installed = await runtime.host.installedVersion()
        if (installed !== this.version) await runtime.host.install(runtime.facts)
        // Provision BEFORE starting: the overlay has to be on disk for the host to
        // load it, and a node whose brain rows are missing would come up looking
        // healthy and then fail its first prompt.
        runtime.phase = 'provision'
        this.#publish()
        const provisioner = new Provisioner({
          configEditor: this.configEditor,
          credentials: this.credentials,
          version: this.version,
          log: message => this.log(`[${runtime.record.name}] ${message}`),
        })
        const plan = provisioner.plan()
        const wrote = await runtime.host.writePatch(plan.text)
        runtime.phase = 'start'
        this.#publish()
        runtime.serving = await runtime.host.ensureServing({
          force: options.force === true,
          patchChanged: wrote.changed,
        })
        runtime.phase = 'verify'
        this.#publish()
        const cookie = await runtime.gateway.cookie(true)
        if (cookie.length === 0) throw new Error('the resident host issued no browser cookie')
        const listed = await runtime.gateway.call('session/list', { _request: {} })
        if (listed.ok !== true) {
          throw new Error(`the resident host refused session/list: ${listed.error?.message ?? 'unknown reason'}`)
        }
        // Credentials last: they can only be pushed once the host answers, and a
        // failure here must be reported without discarding a working connection.
        runtime.provision = { rows: plan.rows.length, disabled: plan.disabled.length, refs: [] }
        try {
          runtime.provision.refs = await provisioner.pushCredentials(runtime.gateway, plan.refs)
        } catch (error) {
          runtime.provision.error = error instanceof Error ? error.message : String(error)
          this.log(`[${runtime.record.name}] could not push credentials: ${runtime.provision.error}`)
        }
        runtime.state = NODE_STATE.CONNECTED
        runtime.phase = undefined
        runtime.registryError = undefined
        this.registry.recordOutcome(runtime.record.id, { ok: true, version: runtime.facts.nodeVersion })
        this.#publish()
        return runtime.describe()
      } catch (error) {
        runtime.state = NODE_STATE.FAILED
        runtime.phase = undefined
        runtime.error = error instanceof Error ? error.message : String(error)
        runtime.serving = undefined
        runtime.gateway.reset()
        this.registry.recordOutcome(runtime.record.id, { ok: false, error: runtime.error })
        this.#publish()
        throw error
      }
    })
  }

  /** Take one node down: cancel routing state, drop SSH, stop the resident Host. */
  async disconnect(runtime) {
    return await this.serial(runtime, async () => {
      runtime.gateway.reset()
      runtime.serving = undefined
      runtime.state = NODE_STATE.IDLE
      runtime.phase = undefined
      await runtime.host.stop().catch(() => undefined)
      // `invalidate` drops the socket so the next connect handshakes afresh.
      // `dispose` would latch the connection shut, and Connect after Disconnect
      // would then fail with "ssh connection was closed" forever.
      runtime.connection.invalidate()
      this.#publish()
      return runtime.describe()
    })
  }

  /** Connect every enabled node at startup without blocking the Host. */
  autoConnect(delayMs = 2_000) {
    return setTimeout(() => {
      for (const runtime of this.list()) {
        if (!runtime.record.enabled) continue
        if (!runtime.credentialsReady()) continue
        void this.connect(runtime).catch(() => undefined)
      }
    }, delayMs)
  }

  /** Release every connection and gateway. */
  dispose() {
    for (const runtime of this.runtimes.values()) {
      try { runtime.gateway.reset() } catch { /* already gone */ }
      try { runtime.connection.dispose() } catch { /* already gone */ }
    }
    this.runtimes.clear()
    this.listeners.clear()
  }

  #runtimeOf(record) {
    const existing = this.runtimes.get(record.id)
    if (existing !== undefined) return existing
    const created = new NodeRuntime(record, { log: this.log, version: this.version })
    this.runtimes.set(record.id, created)
    return created
  }

  async #adoptSecret(runtime) {
    runtime.adopt(await this.secrets.read(runtime.record.id))
  }

  #publish() {
    const nodes = this.list()
    for (const listener of [...this.listeners]) {
      try { listener(nodes) } catch { /* an observer must not break a lifecycle action */ }
    }
  }
}
