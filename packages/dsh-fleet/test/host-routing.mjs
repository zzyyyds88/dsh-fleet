/**
 * Every routable endpoint family, driven through the LOCAL Host's own API.
 *
 * This is the "does the desktop app see a remote machine as one of its own" test:
 * it touches each namespace the routing layer replaces, plus the ones it must
 * leave alone. Nothing reaches into the plugin — every call is what the desktop
 * window and `ds-harness-remote` make.
 *
 * Usage: node test/host-routing.mjs <hostBase> <launchToken>
 */
import { authenticate, call as rawCall, liveStream, openCarrier } from './carrier.mjs'
import { nodeExec } from './node.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/host-routing.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stderr.write(`[host-routing] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const cookie = await authenticate(base, token)
const call = (endpoint, args) => rawCall(base, cookie, endpoint, args)
const carrier = await openCarrier({ base, cookie })

/** Wait until one live stream has at least `count` frames. */
async function settle(stream, count = 1, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && stream.frames.length < count) await sleep(150)
  return stream.frames
}

// ---- 1. session/list merges the node's rows ------------------------------
const listed = await call('session/list', { _request: {} })
const rows = listed.items ?? []
const fleetRows = rows.filter(item => String(item.sessionId).startsWith('fleet_'))
check(fleetRows.length > 0, 'session/list carries remote sessions',
  `${String(fleetRows.length)} of ${String(rows.length)} rows`)
const remoteSession = fleetRows.find(item => String(item.cwd ?? '').startsWith('/'))
check(remoteSession !== undefined, 'a remote row keeps its remote cwd', remoteSession?.cwd)
// Projections have to survive the merge, but not every remote Session has a title: a
// Session that was created moments ago and has not been named yet has none, and the
// newest row is exactly such a Session here. Asserting on whichever row sorts first made
// this check depend on what ran on the node a second earlier — measured: it failed in a
// full run and passed a minute later, which reads like a broken projection but is a test
// that picked a row with no title. The title is asserted on a row this test names itself
// in section 3 below; here the question is only whether any row carries one at all.
const titled = fleetRows.find(item => String(item.projections?.values?.title ?? '').length > 0)
check(titled !== undefined, 'remote rows carry their title projection through the merge',
  titled === undefined ? 'no remote row has a title' : String(titled.projections.values.title).slice(0, 40))

// A local row must still be a local row.
check(rows.some(item => !String(item.sessionId).startsWith('fleet_')),
  'local sessions are still listed untouched')

if (remoteSession === undefined) {
  carrier.close()
  log('no remote session to drive')
  process.exit(1)
}
let sessionId = remoteSession.sessionId

// ---- 2. workspace/follow: one merged baseline ----------------------------
const wsStream = liveStream(carrier, 'workspace/follow', {})
const wsFrames = await settle(wsStream, 1, 10_000)
const baseline = wsFrames.find(frame => frame.value?.type === 'baseline')?.value?.value
check(baseline !== undefined, 'workspace/follow opens with a baseline')
const remoteWorkspaces = (baseline?.items ?? []).filter(item => String(item.workspaceId).startsWith('fleet_'))
check(remoteWorkspaces.length > 0, 'the baseline holds the remote workspace',
  `${String(remoteWorkspaces.length)} remote of ${String((baseline?.items ?? []).length)}`)
check((remoteWorkspaces[0]?.path ?? '').startsWith('/'), 'the remote workspace keeps its real path',
  remoteWorkspaces[0]?.path)
check((baseline?.items ?? []).some(item => !String(item.workspaceId).startsWith('fleet_')),
  'local workspaces survive in the same baseline')
wsStream.stop()

if (remoteWorkspaces.length > 0) {
  // Drive a Session this test owns, in a remote workspace, rather than whatever
  // happens to be newest. A fresh Session has no title and an empty directory, so
  // the file assertions below would be about ambient node state instead of about
  // routing — and they would pass or fail depending on what ran here last.
  const path = String(remoteWorkspaces[0].path)
  const created = await call('session/create', {
    request: { workspaceId: remoteWorkspaces[0].workspaceId },
  })
  const owned = created?.sessionId
  if (typeof owned === 'string') {
    sessionId = owned
    await call('session/rename', { request: { sessionId, title: `routing fixture ${Date.now().toString(36)}` } })
    const reread = await call('session/list', { _request: {} })
    const row = (reread?.items ?? []).find(item => item.sessionId === sessionId)
    check(String(row?.projections?.values?.title ?? '').length > 0,
      'a remote row carries its title', String(row?.projections?.values?.title).slice(0, 40))
  }
  // A verified 4x4 solid-red RGBA PNG plus a text file, written on the node only.
  // The binary-read assertions below need a file that certainly exists and is
  // certainly a PNG; borrowing one from an earlier test's fixture would make this
  // test's result depend on test order.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC'
  await nodeExec([
    `printf 'routing fixture\\n' > ${path}/routing-fixture.txt`,
    `echo '${png}' | base64 -d > ${path}/routing-fixture.png`,
  ].join(' && '))
}

// ---- 3. unary routing ---------------------------------------------------
const state = await call('session/state', { request: { sessionId } })
check(typeof state?.running === 'boolean', 'session/state answers for a remote session',
  JSON.stringify(state).slice(0, 90))

const projections = await call('session/projections', { request: { sessionId } })
check(projections?.values !== undefined || projections?.kind !== undefined,
  'session/projections answers for a remote session', String(projections?.kind))

const page = await call('session/page', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 8 },
})
check(Array.isArray(page?.records) && page.records.length > 0,
  'session/page returns history for a remote session', `${String(page?.records?.length)} records`)
// Event type names must survive the identity translation unchanged: a loose
// `session-` prefix rewrite would corrupt `session-log-deepseek/…`.
check(page.records.every(record => !String(record?.event?.type ?? '').includes('fleet_')),
  'event types are not corrupted by identity translation')

// ---- 4. workspaceFiles through the lookup override ----------------------
// The node derives the real root from its own Session header, so list first and
// stat whatever that workspace actually contains — the point is that the read
// happens on the node, not that a particular filename exists.
try {
  const listing = await call('workspaceFiles/list', {
    workspaceFileScopeId: sessionId,
    path: '.',
  })
  const entries = listing?.entries ?? []
  check(Array.isArray(entries) && entries.length > 0,
    'workspaceFiles/list reads the node directory for a remote session',
    `${String(entries.length)} entries at ${String(remoteSession.cwd)}`)
  // Entries carry `type` ('file' | 'directory'), not `isDirectory`.
  const name = entries.find(entry => entry?.type === 'file')?.name
  if (name !== undefined) {
    const stat = await call('workspaceFiles/stat', {
      workspaceFileScopeId: sessionId,
      path: name,
    })
    check(typeof stat?.absolutePath === 'string' && stat.absolutePath.startsWith('/'),
      'workspaceFiles/stat resolves a node path for a remote session', stat?.absolutePath)
  }
} catch (error) {
  check(false, 'workspaceFiles/list reads the node directory for a remote session',
    `${String(error.code ?? '')} ${error.message}`)
}

// A local session's file scope must still resolve to the local disk. The lookup
// override delegates local ids to the upstream provider verbatim, so a real local
// file has to resolve exactly as it does without this plugin.
const localRow = rows.find(item => !String(item.sessionId).startsWith('fleet_')
  && String(item.cwd ?? '').toUpperCase().includes('DSHPL'))
check(localRow !== undefined, 'a local session from this repository is present', localRow?.cwd)
if (localRow !== undefined) {
  try {
    const localStat = await call('workspaceFiles/stat', {
      workspaceFileScopeId: localRow.sessionId,
      path: 'docs/ARCHITECTURE.md',
    })
    check(typeof localStat?.absolutePath === 'string' && /[\\/]docs[\\/]ARCHITECTURE\.md$/u.test(localStat.absolutePath),
      'a local file scope still resolves locally, to the local disk', localStat?.absolutePath)
  } catch (error) {
    check(false, 'a local file scope still resolves locally',
      `${String(error.code ?? '')} ${error.message}`)
  }
}

// ---- 5. a BINARY read: the Gateway answers multipart, not JSON ----------
// This is the file-preview path (images, PDFs). A JSON-only client sees an
// unparseable `HTTP 200` here, which is easy to misread as a broken node.
try {
  const listing = await call('workspaceFiles/list', { workspaceFileScopeId: sessionId, path: '.' })
  const binary = (listing?.entries ?? []).find(entry => entry?.type === 'file' && /\.png$/u.test(String(entry.name)))
  if (binary !== undefined) {
    const bytes = await call('workspaceFiles/readBytes', {
      workspaceFileScopeId: sessionId,
      path: String(binary.name),
      options: {},
    })
    const payload = bytes?.data
    check(payload instanceof Uint8Array, 'workspaceFiles/readBytes returns real bytes for a remote file',
      Object.prototype.toString.call(payload))
    if (payload instanceof Uint8Array) {
      check(Buffer.from(payload.subarray(0, 8)).toString('hex') === '89504e470d0a1a0a',
        'the bytes are the node PNG, not a placeholder', `${String(payload.length)} bytes`)
    }
    check(String(bytes?.absolutePath ?? '').startsWith('/'),
      'the binary answer still names the node path', bytes?.absolutePath)
  } else {
    log('note: no .png in the remote workspace, skipping the binary read')
  }
} catch (error) {
  check(false, 'workspaceFiles/readBytes returns real bytes for a remote file',
    `${String(error.code ?? '')} ${error.message}`)
}

// The same call must still work for a LOCAL session, unchanged.
if (localRow !== undefined) {
  try {
    const localBytes = await call('workspaceFiles/readBytes', {
      workspaceFileScopeId: localRow.sessionId,
      path: 'docs/ARCHITECTURE.md',
      options: {},
    })
    const payload = localBytes?.data
    check(payload instanceof Uint8Array, 'a local binary read is unaffected',
      Object.prototype.toString.call(payload))
    check(Buffer.from(payload ?? []).includes('#'), 'and it is the local file', `${String(payload?.length)} bytes`)
  } catch (error) {
    check(false, 'a local binary read is unaffected', `${String(error.code ?? '')} ${error.message}`)
  }
}

// ---- 6. prompt the remote brain ----------------------------------------
const marker = `FLEET_E2E_${Date.now()}`
const follow = liveStream(carrier, 'session/follow', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 64 },
})
await sleep(1_500)

const accepted = await call('session/prompt', {
  request: {
    sessionId,
    requestId: `e2e-${Date.now()}`,
    mode: 'queue',
    content: [{
      type: 'text',
      text: `只用 bash 工具执行这一条命令，然后把完整输出原样贴回来：\n`
        + `echo ${marker}; ls -1; wc -l data.txt`,
    }],
  },
})
check(accepted?.accepted === true, 'session/prompt is accepted for a remote session')

const hasResult = frames => frames.some(frame => {
  const records = frame.value?.records
  if (Array.isArray(records)) {
    return records.some(record => record?.event?.type === 'tool/result' && JSON.stringify(record).includes(marker))
  }
  return frame.value?.event?.type === 'tool/result' && JSON.stringify(frame).includes(marker)
})
let sawResult = false
const deadline = Date.now() + 300_000
while (Date.now() < deadline) {
  await sleep(2_000)
  if (hasResult(follow.frames)) { sawResult = true; break }
}
follow.stop()
check(sawResult, 'the merged session/follow stream carries the remote tool result',
  `${String(follow.frames.length)} frames`)

// ---- 7. the job roster reaches the node --------------------------------
// `job/list` and `job/kill` are addressed by Session id, so a remote Session's
// jobs live on its node. The two states to tell apart are "the node says this job
// does not exist" and "this Host answered without asking anyone": a job id that
// certainly does not exist must come back as the node's own `job/not-found`, not
// as a gateway error.
try {
  const killed = await call('job/kill', { request: { sessionId, jobId: 'bash-not-a-real-job' } })
  check(false, 'job/kill reaches the node', `it answered ${JSON.stringify(killed).slice(0, 80)} instead of failing`)
} catch (error) {
  check(error.code === 'job/not-found',
    'job/kill reaches the node for a remote session', `${String(error.code)} ${error.message}`)
}
const jobs = liveStream(carrier, 'job/list', { request: { sessionId } })
const roster = await (async () => {
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    const frame = jobs.frames.find(entry => entry.value?.type === 'rows')?.value
    if (frame !== undefined) return frame
    await sleep(200)
  }
  return undefined
})()
jobs.stop()
check(Array.isArray(roster?.jobs), 'job/list answers a roster for a remote session',
  roster === undefined ? 'no rows frame' : `${String(roster.jobs.length)} job(s)`)

// ---- 8. what must NOT be routed ---------------------------------------
const catalog = await call('session/modelCatalog', {})
check(catalog !== undefined, 'session/modelCatalog still answers from this Host')
const presets = await call('agentPresets/list', {})
check(presets !== undefined, 'an untouched endpoint (agentPresets/list) still answers')

carrier.close()
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exit(0)
}
