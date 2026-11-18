/**
 * The one tool a node-control session has: `fleet_nodes`.
 *
 * This module is deliberately a **separate entry point** (`@local/dsh-fleet/node-control`)
 * rather than part of the Host half. An agent preset's `config.plugins` names packages,
 * and a preset that mounted the whole fleet plugin would drag the routing decorators,
 * the SSH watchdog and the settings API into an agent scope — where they do not belong
 * and where half of them would fail to compose. Mounting one tool package is the whole
 * requirement.
 *
 * It also imports nothing from `@deepseek-ai/*`: the definition below is the plain
 * object `ctx.tools.register` validates (`{ name, description, parameters, output }`),
 * with `parameters` already raw JSON Schema. That is the same rule the rest of this
 * plugin follows, and it is what keeps a preset working across an upstream patch
 * release that reorganises its type-only exports.
 *
 * @module @local/dsh-fleet/node-control
 */

/** Stable Cordis plugin name. */
export const name = 'fleet-node-control'

/**
 * The two services this tool needs.
 *
 * `fleetControl` is registered by the Host half; a profile that composes this preset
 * without the fleet plugin therefore fails at load with a named missing service rather
 * than at the first tool call with `undefined`.
 */
export const inject = ['tools', 'fleetControl']

/** Actions this tool accepts, in the order the description lists them. */
const ACTIONS = ['list', 'add', 'update', 'remove', 'connect', 'disconnect', 'status']

const DESCRIPTION = [
  'Manage the remote nodes this machine records — the machines whose workspaces and',
  'sessions appear in the sidebar as if they were local.',
  '',
  'list       — every node with its state and whether a credential is stored. Costs nothing.',
  'add        — add one node: name, host, port, username, and auth.',
  'update     — change name/host/port/username/remoteRoot/enabled for one node id.',
  'remove     — forget one node and delete its stored credential. The node itself is untouched.',
  'connect    — connect and report the final state, or the reason it failed.',
  'disconnect — disconnect while keeping the record.',
  'status     — one node current state.',
  '',
  'Never ask the user for a password or a private key: tool arguments are recorded in the',
  'session log. `auth` names a reference that already exists on this machine:',
  '  {"kind":"key","path":"~/.ssh/id_ed25519"}   a private-key file',
  '  {"kind":"password","env":"DSH_FLEET_NODE_PW"}   an environment variable name',
  '  {"kind":"agent"}   this machine SSH agent (the default)',
  'To have the user paste a secret directly, send them to Settings > Remote nodes.',
].join('\n')

/** One node as every action reports it. */
const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'host', 'port', 'username', 'authKind', 'credentialsReady', 'enabled', 'remoteRoot', 'state'],
  properties: {
    id: { type: 'string', description: 'Node identity: n plus 12 hex characters.' },
    name: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'integer' },
    username: { type: 'string' },
    authKind: { type: 'string', enum: ['password', 'key', 'agent'] },
    credentialsReady: { type: 'boolean', description: 'Whether a usable credential is stored.' },
    enabled: { type: 'boolean', description: 'Whether opening this profile tries to connect.' },
    remoteRoot: { type: 'string', description: 'Install directory on the node.' },
    state: { type: 'string', enum: ['idle', 'connecting', 'connected', 'failed'] },
    error: { type: 'string', description: 'Why the last connection attempt failed.' },
    remote: {
      type: 'object',
      additionalProperties: true,
      description: 'What the node reported about itself when it was probed.',
    },
  },
}

/** The canonical result: what the call did, plus the node rows it touched. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'summary', 'nodes'],
  properties: {
    action: { type: 'string', enum: ACTIONS },
    summary: { type: 'string', description: 'One sentence, safe to show as a card title.' },
    nodes: { type: 'array', items: NODE_SCHEMA },
    notes: { type: 'array', items: { type: 'string' }, description: 'Caveats worth passing on.' },
  },
}

/**
 * Turn one service answer into the bounded shape declared above.
 *
 * Trimmed here rather than by validation: an extra field from a future version must not
 * turn a successful call into a schema error, and the model-facing value should be the
 * same one a person reads in the settings page.
 *
 * @param {Array<Record<string, unknown>>} nodes
 * @returns {Array<Record<string, unknown>>}
 */
function bounded(nodes) {
  return nodes.map(node => ({
    id: String(node.id),
    name: String(node.name),
    host: String(node.host),
    port: Number(node.port),
    username: String(node.username),
    authKind: String(node.authKind ?? 'agent'),
    credentialsReady: node.credentialsReady === true,
    enabled: node.enabled !== false,
    remoteRoot: String(node.remoteRoot ?? ''),
    state: String(node.state ?? 'idle'),
    ...(typeof node.error === 'string' ? { error: node.error } : {}),
    ...(node.remote === null || typeof node.remote !== 'object' ? {} : { remote: node.remote }),
  }))
}

/** One action's required identity, named in the failure so the model can fix it. */
function requireId(id, action) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${action} needs "id": call fleet_nodes with action "list" first`)
  }
}

/**
 * Mount the tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - a context carrying `tools` and `fleetControl`.
 */
export function apply(ctx) {
  const control = ctx.fleetControl
  ctx.tools.register({
    name: 'fleet_nodes',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'What to do. "list" is the cheap one and needs no other field.',
        },
        id: { type: 'string', description: 'Node identity. Required for status, update, remove, connect and disconnect.' },
        name: { type: 'string', description: 'Display name, for add and update.' },
        host: { type: 'string', description: 'Host name or address, for add and update.' },
        port: { type: 'integer', description: 'SSH port. Defaults to 22.' },
        username: { type: 'string', description: 'Login user, for add and update.' },
        remoteRoot: { type: 'string', description: 'Install directory on the node. Defaults to ~/.dsh-fleet.' },
        enabled: { type: 'boolean', description: 'Whether opening this profile tries to connect.' },
        auth: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          description: 'A reference to a credential on this machine, never the credential itself.',
          properties: {
            kind: {
              type: 'string',
              enum: ['key', 'password', 'agent'],
              description: 'key = private-key file; password = environment variable; agent = the local SSH agent.',
            },
            path: { type: 'string', description: 'For kind=key: path of the private-key file, e.g. ~/.ssh/id_ed25519.' },
            env: { type: 'string', description: 'For kind=password: the name of an environment variable on this machine.' },
          },
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = value.nodes.length === 0
          ? ['No nodes are recorded on this machine.']
          : value.nodes.map(node => `- ${node.name} (${node.id}) ${node.username}@${node.host}:${node.port} — ${node.state}`
            + `${node.error === undefined ? '' : `: ${node.error}`}`)
        const notes = Array.isArray(value.notes) ? value.notes : []
        return [{ type: 'text', text: [value.summary, '', ...lines, ...(notes.length === 0 ? [] : ['', ...notes])].join('\n') }]
      },
    },

    async execute(args) {
      const action = args.action
      switch (action) {
        case 'list': {
          const nodes = bounded(control.list())
          return { action, summary: `${String(nodes.length)} node(s) recorded.`, nodes }
        }
        case 'add': {
          const { node, notes } = await control.add({
            name: args.name,
            host: args.host,
            port: args.port,
            username: args.username,
            remoteRoot: args.remoteRoot,
            enabled: args.enabled,
            auth: args.auth,
          })
          return {
            action,
            summary: `Added ${String(node.name)}.`,
            nodes: bounded([node]),
            ...(notes.length === 0 ? {} : { notes }),
          }
        }
        case 'update': {
          requireId(args.id, 'update')
          const { node, notes } = await control.update(args.id, {
            name: args.name,
            host: args.host,
            port: args.port,
            username: args.username,
            remoteRoot: args.remoteRoot,
            enabled: args.enabled,
          })
          return {
            action,
            summary: `Updated ${String(node.name)}.`,
            nodes: bounded([node]),
            ...(notes.length === 0 ? {} : { notes }),
          }
        }
        case 'remove': {
          requireId(args.id, 'remove')
          const { removed } = await control.remove(args.id)
          return {
            action,
            summary: removed ? `Removed ${String(args.id)}.` : `${String(args.id)} was already gone.`,
            nodes: bounded(control.list()),
          }
        }
        case 'connect': {
          requireId(args.id, 'connect')
          const { node } = await control.connect(args.id)
          return {
            action,
            summary: node.state === 'connected'
              ? `Connected to ${String(node.name)}.`
              : `${String(node.name)} is ${String(node.state)}${node.error === undefined ? '' : `: ${String(node.error)}`}`,
            nodes: bounded([node]),
          }
        }
        case 'disconnect': {
          requireId(args.id, 'disconnect')
          const { node } = await control.disconnect(args.id)
          return { action, summary: `Disconnected ${String(node.name)}.`, nodes: bounded([node]) }
        }
        case 'status': {
          requireId(args.id, 'status')
          const { node } = control.status(args.id)
          return { action, summary: `${String(node.name)} is ${String(node.state)}.`, nodes: bounded([node]) }
        }
        default:
          // Unreachable through the declared enum; kept so a direct caller gets a sentence
          // rather than a silently undefined result.
          throw new Error(`unknown action ${String(action)}; expected one of ${ACTIONS.join(', ')}`)
      }
    },

    // Two calls changing the same record must not interleave their read-modify-write.
    isConcurrencySafe: () => false,

    presentCall: args => ({
      card: 'generic',
      title: `Remote nodes: ${String(args.action)}`,
      kind: 'other',
      rawInput: args.action === 'list' ? undefined : { action: args.action, id: args.id, name: args.name },
    }),
  })
}
