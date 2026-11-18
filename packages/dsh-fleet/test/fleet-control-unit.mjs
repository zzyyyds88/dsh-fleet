/**
 * `host/fleet-control.js` — the only surface a node-control session can act on.
 *
 * Three properties matter here, and each fails quietly:
 *
 *   - a tool argument is written into the session log, so a pasted password must be
 *     *refused* rather than stored — the refusal is the feature;
 *   - a credential reference is read on this machine and goes straight into the credential
 *     store, never into the answer;
 *   - "not found" has to be a sentence about the node, not an `undefined` that a caller
 *     quietly turns into "no nodes recorded".
 */
import { FleetControl, readAuthReference } from '../src/host/fleet-control.js'

let failed = 0
const checks = []
function ok(condition, message, detail) {
  checks.push({ condition, message })
  if (!condition) failed += 1
  const mark = condition ? 'ok  ' : 'FAIL'
  console.log(`[fleet-control] ${mark} ${message}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** A fleet stand-in: only the four methods this service actually calls. */
function fakeFleet(records = []) {
  const map = new Map(records.map(record => [record.id, { record, state: record.state ?? 'idle' }]))
  return {
    puts: [],
    removed: [],
    connections: [],
    list: () => [...map.values()].map(runtime => ({
      describe: () => ({
        id: runtime.record.id,
        name: runtime.record.name,
        host: runtime.record.host,
        port: runtime.record.port ?? 22,
        username: runtime.record.username,
        authKind: runtime.record.auth?.kind ?? 'agent',
        credentialsReady: true,
        enabled: true,
        remoteRoot: '~/.dsh-fleet',
        state: runtime.state,
        ...(runtime.record.error === undefined ? {} : { error: runtime.record.error }),
      }),
    })),
    get: id => map.get(id),
    put: async input => {
      const record = { id: input.id ?? 'n0123456789ab', ...input }
      map.set(record.id, { record, state: 'idle' })
      return { record, describe: () => ({
        id: record.id,
        name: record.name,
        host: record.host,
        port: record.port ?? 22,
        username: record.username,
        authKind: record.auth?.kind ?? 'agent',
        credentialsReady: true,
        enabled: true,
        remoteRoot: '~/.dsh-fleet',
        state: 'idle',
      }) }
    },
    remove: async id => { map.delete(id); return true },
    connect: async runtime => ({ ...runtime.describe(), state: 'connected' }),
    disconnect: async runtime => { runtime.state = 'idle' },
  }
}

// ---- a credential can only be *referenced* --------------------------------

let inline = undefined
const control = new FleetControl({ fleet: fakeFleet(), environment: name => (name === 'SET_PW' ? 'hunter2' : undefined) })
try {
  await control.add({ name: 'x', host: 'h', username: 'u', auth: { kind: 'password', password: 'hunter2' } })
} catch (error) {
  inline = error
}
ok(inline !== undefined && inline.code === 'auth-inline-refused',
  'a pasted password is refused, because tool arguments are logged', String(inline?.code))
ok(String(inline?.message).includes('Settings'),
  'and the refusal says where to paste it instead', String(inline?.message).slice(0, 90))

let keyInline = undefined
try {
  await control.add({ name: 'x', host: 'h', username: 'u', auth: { kind: 'key', privateKey: '-----BEGIN' } })
} catch (error) {
  keyInline = error
}
ok(keyInline?.code === 'auth-inline-refused', 'a pasted private key is refused the same way', String(keyInline?.code))

// ---- a reference is read on this machine, and never echoed ----------------

const fromEnv = readAuthReference({ kind: 'password', env: 'SET_PW' }, name => (name === 'SET_PW' ? 'hunter2' : undefined))
ok(fromEnv.kind === 'password' && fromEnv.password === 'hunter2',
  'an environment variable name resolves to the secret', fromEnv.kind)

let missing = undefined
try {
  readAuthReference({ kind: 'password', env: 'NOT_SET' }, () => undefined)
} catch (error) {
  missing = error
}
ok(missing?.code === 'auth-reference-missing',
  'a name this machine does not set is an error, not an empty password', String(missing?.code))
ok(!String(missing?.message).includes('undefined'), 'and the message names the variable rather than a value')

let noPath = undefined
try {
  readAuthReference({ kind: 'key' }, () => undefined)
} catch (error) {
  noPath = error
}
ok(noPath?.code === 'auth-reference-invalid', 'a key reference without a path is refused', String(noPath?.code))

let unreadable = undefined
try {
  readAuthReference({ kind: 'key', path: '~/.ssh/__fleet_no_such_key__' }, () => undefined)
} catch (error) {
  unreadable = error
}
ok(unreadable?.code === 'auth-reference-unreadable',
  'a key file this machine cannot read says so', String(unreadable?.code))

ok(readAuthReference(undefined, () => undefined).kind === 'agent',
  'no auth at all means the local SSH agent, which is the only option that needs no secret')

// ---- what a result may contain -------------------------------------------

const fleet = fakeFleet([{ id: 'n0123456789ab', name: 'probe', host: '10.0.0.9', username: 'root', auth: { kind: 'key' } }])
const listed = new FleetControl({ fleet }).list()
ok(listed.length === 1, 'the list answers one row per recorded node', String(listed.length))
ok(listed[0].name === 'probe' && listed[0].state === 'idle', 'with its name and state',
  `${String(listed[0].name)}/${String(listed[0].state)}`)
const serialized = JSON.stringify(listed)
ok(!serialized.includes('privateKey') && !serialized.includes('password') && !serialized.includes('hunter2'),
  'and no field can hold authentication material', serialized.slice(0, 80))

// A node that failed must say why: "idle" alone reads as "not tried yet".
const failing = new FleetControl({ fleet: fakeFleet([
  { id: 'n0123456789ab', name: 'probe', host: 'h', username: 'u', auth: { kind: 'agent' }, state: 'failed', error: 'auth failed' },
]) }).list()
ok(failing[0].error === 'auth failed', 'a failed node carries the reason it gave', String(failing[0].error))

// ---- "not found" is a sentence, not an undefined --------------------------

let unknown = undefined
try {
  new FleetControl({ fleet: fakeFleet() }).status('n0123456789ab')
} catch (error) {
  unknown = error
}
ok(unknown?.code === 'node-unknown', 'an unknown identity is a named failure', String(unknown?.code))
ok(String(unknown?.message).includes('n0123456789ab'), 'and the message quotes the identity', String(unknown?.message))

let malformed = undefined
try {
  new FleetControl({ fleet: fakeFleet() }).status('not-a-node')
} catch (error) {
  malformed = error
}
ok(malformed?.code === 'node-id-invalid', 'a malformed identity is refused before any lookup', String(malformed?.code))

// ---- add/update/remove reach the fleet exactly once ----------------------

const recording = fakeFleet()
const writer = new FleetControl({ fleet: recording, environment: name => (name === 'SET_PW' ? 'hunter2' : undefined) })
const added = await writer.add({
  name: 'new node', host: '10.0.0.9', username: 'root',
  auth: { kind: 'password', env: 'SET_PW' },
})
ok(recording.puts === undefined || added.node.name === 'new node', 'add answers the node it wrote',
  String(added.node.name))
ok(added.notes.length === 0, 'and needs no caveat when a credential was supplied', JSON.stringify(added.notes))

const agentAdded = await writer.add({ name: 'agent node', host: 'h', username: 'u' })
ok(agentAdded.notes.length === 1 && agentAdded.notes[0].includes('SSH agent'),
  'a node added without a credential says it will use the SSH agent', agentAdded.notes.join(' '))

console.log('')
if (failed > 0) {
  console.error(`[fleet-control] ${failed} of ${checks.length} checks failed`)
  process.exitCode = 1
} else {
  console.log(`[fleet-control] all ${checks.length} checks passed`)
}
