/**
 * The node-control "mode", proved end to end through the local `/api`.
 *
 * The claim is narrow and it is a claim about a **composition**, not about a prompt:
 *
 *   a Session created from the `node-control` preset can only manage nodes, because that
 *   preset declares exactly one tool and every product tool row is disabled on the host
 *   plane. "Refuse the rest" is therefore the composition's answer, not the model's.
 *
 * Four things have to be true of the running Host, and none of them is visible from a unit
 * test:
 *
 *   1. the preset is registered and declares two rows — a persona and this plugin's own
 *      `./node-control` entry point (which is what `dsh.bundle.patch` being an array buys);
 *   2. a Session can be created from it, and its projections say it runs that preset;
 *   3. a real turn drives `fleet_nodes` and **no other tool at all** — the observable form
 *      of "this session has one tool";
 *   4. the tool answers real data (the recorded nodes) rather than a schema-shaped empty
 *      shell, and a node that does not exist would be a named failure rather than a blank.
 *
 * Usage: node test/node-control.mjs <hostBase> <launchToken>
 */
import { authenticate, call as rawCall } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/node-control.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stderr.write(`[node-control] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

const cookie = await authenticate(base, token)
const call = (endpoint, args) => rawCall(base, cookie, endpoint, args)

// ---- 1. the preset, and what it declares ----------------------------------

const presets = await call('agentPresets/list', {})
const rows = presets?.items ?? presets?.presets ?? (Array.isArray(presets) ? presets : [])
const ids = rows.map(row => row.id ?? row.presetId ?? row.name)
check(ids.includes('node-control'), 'the node-control preset is registered', ids.join(','))

// `agentPresets/read` answers the declared plugin list as YAML — the same document the
// settings page shows. Its argument is the identity itself (a first-positional-argument
// namespace, unlike `session/*`).
const document = await call('agentPresets/read', { agentPreset: 'node-control' })
  .catch(error => ({ error: `${String(error.code)} ${error.message}` }))
const content = String(document?.content ?? '')
check(content.includes('@greatbaby/dsh-fleet/node-control'),
  'and it mounts this plugin\'s own tool entry point',
  content.length === 0 ? String(document?.error) : 'declared')
check(!/@deepseek-ai\/dsh-tool-/u.test(content),
  'with no product tool row in it', content.length === 0 ? '(no document)' : 'none')
const declaredRows = content.split('\n').filter(line => /^\s*-\s*id:\s/u.test(line)
  || /^\s*id:\s/u.test(line)).length
check(declaredRows === 2, 'exactly two rows: the persona and the tool', `${String(declaredRows)} row(s)`)

// ---- 2. a Session from that preset ---------------------------------------

const created = await call('session/create', {
  request: { agentPreset: 'node-control', title: `node control ${Date.now().toString(36)}` },
})
const sessionId = created?.sessionId
check(typeof sessionId === 'string', 'a Session can be created from the preset', String(sessionId))
if (typeof sessionId !== 'string') {
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
const projections = await call('session/projections', { request: { sessionId } })
check(projections?.values?.agentPreset === 'node-control',
  'and its projections say it runs that preset',
  String(projections?.values?.agentPreset ?? projections?.kind ?? 'none'))

// ---- 3. one real turn: the tool runs, and nothing else does ---------------
// A prompt that can only be answered by calling the tool. What is asserted is not the
// prose: it is the set of tool names the model was able to call.
const marker = Date.now().toString(36)
await call('session/prompt', {
  request: {
    sessionId,
    requestId: `node-control-${marker}`,
    mode: 'queue',
    content: [{
      type: 'text',
      text: 'Use your tool to list the remote nodes recorded on this machine, then reply DONE '
        + 'with the number of nodes.',
    }],
  },
})

const events = new Map()
const deadline = Date.now() + 300_000
while (Date.now() < deadline) {
  await sleep(2_000)
  const page = await call('session/page', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 300 },
  }).catch(() => undefined)
  for (const record of page?.records ?? []) {
    const event = record?.event
    if (event === undefined) continue
    events.set(event.seq, event)
  }
  if ([...events.values()].some(event => event.type === 'turn/end')) break
}
const ordered = [...events.values()].sort((left, right) => left.seq - right.seq)
check(ordered.some(event => event.type === 'turn/end'),
  'the turn finished', `${String(ordered.length)} event(s)`)

const calls = ordered.filter(event => event.type === 'tool/call')
const names = [...new Set(calls.map(event => String(event.data?.name)))]
check(calls.length > 0, 'the model called a tool', names.join(',') || '(none)')
check(names.length === 1 && names[0] === 'fleet_nodes',
  'and the only tool it could call is fleet_nodes', names.join(',') || '(none)')

// The result has to be real data: a tool that answers a schema-shaped empty value would
// satisfy the name check and tell the model nothing.
const results = ordered.filter(event => event.type === 'tool/result')
const text = JSON.stringify(results.map(event => event.data))
check(text.includes('recorded'), 'the tool answered with the node roster', text.slice(0, 200))
check(!/"isError":true/u.test(text), 'and did not fail', text.slice(0, 200))

// ---- 4. the surface behind the tool ---------------------------------------
// A regression that drops the service (a missing `inject`, a `provide` behind an
// unreachable branch) turns the tool into a runtime error the model then reports as prose.
const nodes = await fetch(`${base}/fleet/api/nodes`, { headers: { cookie } })
  .then(response => response.json())
check(nodes.ok === true, 'the fleet service behind the tool is composed',
  JSON.stringify(nodes).slice(0, 80))
check(Array.isArray(nodes.nodes) && nodes.nodes.length > 0,
  'and records at least one node', `${String((nodes.nodes ?? []).length)} node(s)`)

log(failures.length === 0 ? 'all checks passed' : `${String(failures.length)} failed`)
await sleep(250)
process.exit(failures.length === 0 ? 0 : 1)
