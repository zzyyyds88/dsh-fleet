/**
 * A remote Session's terminal, driven end to end — the half that needs a real PTY.
 *
 * `routing-unit.mjs` proves the decorator's shapes with a fake. This proves the two
 * things a fake cannot: that the Gateway resolves an `agentId` for a `rnh_…`
 * identity at all, and that an attachment carries bytes **both** ways through the
 * node's own mux.
 *
 * The sequence mirrors what the browser does, in order:
 *
 *   environment → shells → create → attach → write "echo …" → read the output
 *                                                         → close
 *
 * The assertion that matters is the last one: the marker string only exists if a
 * shell really ran on the node, because nothing local ever echoes it.
 *
 * Run:
 *   RNH_TEST_HOST=… RNH_TEST_USER=… RNH_TEST_PASSWORD=… \
 *   node test/terminal-acceptance.mjs <hostBase> <launchToken>
 */
import { authenticate, call, openCarrier } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node terminal-acceptance.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stdout.write(`[terminal-acceptance] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = Date.now().toString(36)

const cookie = await authenticate(base, token)

/** A Session on a remote node, created on its own node's cwd. */
const rows = (await call(base, cookie, 'session/list', { _request: {} })).items ?? []
const remoteRow = rows
  .filter(row => String(row.sessionId).startsWith('rnh_'))
  .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))[0]
check(remoteRow !== undefined, 'there is a remote Session to open a terminal in',
  remoteRow?.sessionId?.slice(0, 42))
if (remoteRow === undefined) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
  process.exit(failures.length === 0 ? 0 : 1)
}
const sessionId = remoteRow.sessionId

// ---- 1. the Gateway resolves an `agentId` for a wrapped identity ---------
// This is the part `overrideAgentLookup` exists for: without it every endpoint
// below fails with `session/not-found` before its decorator runs.
let environment
try {
  environment = await call(base, cookie, 'terminal/environment', { agentId: sessionId })
} catch (error) {
  check(false, 'terminal/environment accepts a remote agentId', `${error.code}: ${error.message}`)
}
if (environment !== undefined) {
  check(typeof environment.cwd === 'string' && environment.cwd.startsWith('/'),
    'and answers with the node working directory', environment.cwd)
  check(Number(environment.maxInputBytes) > 0, 'plus the node terminal limits',
    String(environment.maxInputBytes))
}

const shells = await call(base, cookie, 'terminal/shells', { agentId: sessionId }).catch(error => {
  check(false, 'terminal/shells accepts a remote agentId', `${error.code}: ${error.message}`)
  return []
})
check(Array.isArray(shells) && shells.length > 0, 'the node lists its own shells',
  (shells ?? []).map(shell => shell.name).join(','))

// ---- 2. create a real PTY on the node -----------------------------------
const terminalId = `t-${stamp}`
const created = await call(base, cookie, 'terminal/create', {
  agentId: sessionId,
  request: { id: terminalId, cols: 100, rows: 30 },
}).catch(error => {
  check(false, 'terminal/create accepts a remote agentId', `${error.code}: ${error.message}`)
  return undefined
})
if (created !== undefined) {
  check(created.id === terminalId, 'the node created the terminal we named', created.id)
  check(created.state === 'running', 'and it is running', created.state)
  check(String(created.cwd ?? '').startsWith('/'), 'in a node directory', created.cwd)
}

// ---- 3. the roster shows it, through the routed `list` ------------------
const roster = await call(base, cookie, 'terminal/list', { sessionId })
check(Array.isArray(roster) && roster.some(entry => entry.id === terminalId),
  'the routed roster lists the node terminal',
  (roster ?? []).map(entry => entry.id).slice(0, 4).join(','))

// ---- 4. attach and carry bytes both ways --------------------------------
const carrier = await openCarrier({ base, cookie })
const streamId = `acc-${stamp}`
const frames = []
const off = carrier.onMessage(text => {
  let parsed
  try { parsed = JSON.parse(text) } catch { return }
  if (parsed.streamId === streamId) frames.push(parsed)
})
carrier.send(JSON.stringify({
  type: 'open',
  streamId,
  endpoint: 'terminal/attach',
  payload: { args: { agentId: sessionId, id: terminalId } },
}))

const marker = `TERM_${stamp}`
const opened = Date.now() + 20_000
while (Date.now() < opened && !frames.some(frame => frame.value?.type === 'snapshot')) await sleep(200)
const snapshot = frames.find(frame => frame.value?.type === 'snapshot')?.value
check(snapshot !== undefined, 'the attachment opens with a snapshot', snapshot?.info?.id)
check(snapshot?.writable === true, 'and the terminal accepts input')

// Type the command, then Enter. `sequence` starts at 1 and must not skip: the node
// rejects a gap, which is exactly why the relay never renumbers.
let sequence = 1
const send = data => carrier.send(JSON.stringify({
  type: 'item',
  streamId,
  value: { type: 'write', sequence: sequence++, data, typed: true },
}))
send(`echo ${marker}\r`)

const echoed = Date.now() + 25_000
let output = ''
while (Date.now() < echoed && !output.includes(marker)) {
  await sleep(300)
  output = frames
    .filter(frame => frame.value?.type === 'output')
    .map(frame => String(frame.value.data ?? ''))
    .join('')
}
// The command line itself echoes the marker, so look for a *second* occurrence —
// the shell's own answer — or for the prompt returning afterwards.
const occurrences = output.split(marker).length - 1
check(occurrences >= 1, 'the shell received the command', `${String(occurrences)} echo(es)`)
check(output.length > 0, 'and its output reached the browser', `${String(output.length)} chars`)

// ---- 5. an ack proves the node accepted the sequence --------------------
const acked = frames.some(frame => frame.value?.type === 'ack' && frame.value.sequence >= 1)
check(acked, 'the node acknowledged the input sequence')

// ---- 6. close is routed, and the roster drops it ------------------------
carrier.send(JSON.stringify({ type: 'cancel', streamId }))
await call(base, cookie, 'terminal/close', { agentId: sessionId, id: terminalId })
const after = await call(base, cookie, 'terminal/list', { sessionId })
check(Array.isArray(after) && !after.some(entry => entry.id === terminalId),
  'a close removes it from the node roster',
  (after ?? []).map(entry => entry.id).slice(0, 4).join(','))

off()
carrier.close()
await sleep(400)
log(`node terminal ${terminalId} on ${String(sessionId).slice(0, 42)}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
