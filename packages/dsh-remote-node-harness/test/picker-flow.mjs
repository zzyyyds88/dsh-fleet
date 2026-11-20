/**
 * The phone's view of a node: `/@rnh/<nodeId>/…`.
 *
 * `ds-harness-remote` asks this Host for an *absolute path on the Host* and nothing else,
 * so a node has to be addressable inside that one path syntax. This test drives exactly
 * the two endpoints the phone calls and checks the three things that decide whether the
 * phone can use a node at all:
 *
 *   1. `directoryPicker/list` answers — on a desktop the composed backend is `native`,
 *      whose capability has no `list`, so an inherited method would refuse here;
 *   2. a browser that names **no path** lands on the device layer (this machine + every
 *      connected node), which is the only level the phone can reach without already
 *      knowing a namespace path; `/@rnh` is that same level, and `/@rnh/<id>/…`
 *      lists a machine's real folders, each entry spelled back with the namespace;
 *   3. `workspace/create` with such a path puts the workspace **on the node**, and the
 *      empty directory chain the relay created on this desktop before dispatching is gone
 *      afterwards — no `<drive>:\@rnh` left behind.
 *
 * Usage: node test/picker-flow.mjs <hostBase> <launchToken>
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { authenticate, call as rawCall } from './carrier.mjs'
import { nodeExec } from './node.mjs'
import { PICKER_PREFIX, decodePickerPath, localShadowOf, pruneShadow } from '../src/host/picker-paths.js'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/picker-flow.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stderr.write(`[picker-flow] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

const cookie = await authenticate(base, token)
const call = (endpoint, args) => rawCall(base, cookie, endpoint, args)
const get = async path => {
  const response = await fetch(`${base}/rnh/api${path}`, { headers: { cookie } })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? {} : JSON.parse(text) }
}

// ---- 0. a connected node, or nothing to test -------------------------------

const nodes = (await get('/nodes')).body.nodes ?? []
const remote = nodes.find(node => node.id !== undefined)
if (remote === undefined) {
  log('no remote node is configured; nothing to browse')
  process.exit(3)
}
if (remote.state !== 'connected') {
  await fetch(`${base}/rnh/api/nodes/${remote.id}/connect`, { method: 'POST', headers: { cookie } })
  const deadline = Date.now() + 240_000
  let state = remote.state
  while (Date.now() < deadline) {
    const fresh = (await get('/nodes')).body.nodes ?? []
    state = fresh.find(node => node.id === remote.id)?.state
    if (state === 'connected' || state === 'failed') break
    await sleep(1_000)
  }
  if (state !== 'connected') {
    log(`node ${remote.id} is ${String(state)}; the deployment cannot answer, not this behaviour`)
    process.exit(3)
  }
}

// ---- 1. the device layer: where a phone that names no path lands -----------

// The phone opens its folder browser with no path at all, so this call is the one screen
// a user actually sees first. It has to be the machine list: a home directory here is a
// level with no way out, because the only row the browser can follow is one it renders.
const home = await call('directoryPicker/list', {})
check(typeof home?.path === 'string' && Array.isArray(home?.crumbs),
  'a listing with no path still answers a full level', JSON.stringify(home).slice(0, 100))
check(home?.path === PICKER_PREFIX, 'and that level is the device layer, not this machine\'s home',
  String(home?.path))
check(home?.home === PICKER_PREFIX,
  'so the browser\'s home action comes back here, not to a directory', String(home?.home))
check(Array.isArray(home?.crumbs) && home.crumbs.length === 1 && home.crumbs[0]?.path === PICKER_PREFIX,
  'one crumb, so the phone cannot walk above the machine list', JSON.stringify(home?.crumbs))
const deviceRows = Array.isArray(home?.entries) ? home.entries : []
// The row is identified by its **path**, not its name: the Host half has no locale, so the
// name is whatever this machine calls itself (`localMachineName()` — its hostname). Pinning
// a name here would make the suite fail on a machine with a different hostname, which says
// nothing about whether the level works.
const thisDevice = deviceRows[0]
check(thisDevice !== undefined, 'this machine is a row, not a header the browser cannot tap',
  deviceRows.map(row => row.name).join(','))
check(typeof thisDevice?.path === 'string' && isAbsolute(thisDevice.path),
  'and its path is an absolute local path, so opening it is the same call as opening a node',
  String(thisDevice?.path))
check(resolve(thisDevice.path) === resolve(homedir()),
  'that path is this machine\'s home, which is what an empty path used to mean',
  `${String(thisDevice?.path)} vs ${homedir()}`)
check(typeof thisDevice?.name === 'string' && thisDevice.name.length > 0,
  'the row carries a name the phone can render', String(thisDevice?.name))
check(deviceRows.some(row => row.path === `${PICKER_PREFIX}/${remote.id}`),
  `the connected node is a row too: ${PICKER_PREFIX}/<id>`, deviceRows.map(row => row.path).join(','))
check(deviceRows.every(row => row.path === thisDevice?.path || decodePickerPath(row.path) !== undefined),
  'every row is a path this Host can decode or list again',
  deviceRows.map(row => `${row.name}=${row.path}`).join(' | ').slice(0, 200))
const nodeRows = deviceRows.filter(row => decodePickerPath(row.path) !== undefined)
check(nodeRows.every((row, index) => index === 0 || nodeRows[index - 1].name.localeCompare(row.name) <= 0),
  'the nodes keep the order the node list gives them', nodeRows.map(row => row.name).join(','))

// The same level is reachable by naming it, which is how a crumb comes back to it.
const top = await call('directoryPicker/list', { path: PICKER_PREFIX })
check(typeof top?.path === 'string', 'directoryPicker/list answers for the namespace', JSON.stringify(top).slice(0, 120))
check(top?.path === PICKER_PREFIX, 'and reports the namespace as its own path', String(top?.path))
check(top?.home === PICKER_PREFIX,
  'the browser roots its breadcrumbs here, not at this machine\'s home', String(top?.home))
check(top?.path === home?.path && top?.home === home?.home
  && JSON.stringify(top?.crumbs) === JSON.stringify(home?.crumbs)
  && top?.entries?.[0]?.path === thisDevice?.path,
  'naming the namespace and naming nothing are the same screen',
  JSON.stringify({ path: top?.path, home: top?.home, first: top?.entries?.[0]?.name }).slice(0, 120))
const rows = Array.isArray(top?.entries) ? top.entries : []
check(rows.some(row => row.path === `${PICKER_PREFIX}/${remote.id}`),
  `the node is listed as ${PICKER_PREFIX}/<id>`, rows.map(row => row.path).join(','))

// Following the "this machine" row is what makes the level useful: it has to be an
// ordinary local listing, and it has to keep a crumb back to the machine list or the
// browser is stuck on one machine forever.
const local = await call('directoryPicker/list', { path: thisDevice?.path })
check(typeof local?.path === 'string' && resolve(local.path) === resolve(thisDevice?.path),
  'opening this machine lists its own directory', String(local?.path))
check(local?.home === thisDevice?.path, 'and its home is still the local home, as "this machine" means',
  String(local?.home))
check(Array.isArray(local?.entries) && local.entries.length > 0, 'it has folders in it',
  `${String((local?.entries ?? []).length)} row(s)`)
check((local?.entries ?? []).every(row => isAbsolute(row.path) && decodePickerPath(row.path) === undefined),
  'and its rows are plain absolute local paths, not namespace paths',
  (local?.entries ?? []).slice(0, 3).map(row => row.path).join(' '))
check((local?.crumbs ?? [])[0]?.path === PICKER_PREFIX,
  'the crumb row starts at the device layer, so a node is still reachable from here',
  JSON.stringify((local?.crumbs ?? []).map(crumb => crumb.path)))
check((local?.crumbs ?? []).at(-1)?.path === local?.path,
  'and the crumb row still reaches the directory being listed',
  JSON.stringify((local?.crumbs ?? []).map(crumb => crumb.path)))

// ---- 2. one node's own filesystem ------------------------------------------

const nodeRoot = await call('directoryPicker/list', { path: `${PICKER_PREFIX}/${remote.id}` })
check(nodeRoot?.path === `${PICKER_PREFIX}/${remote.id}`, 'the node root is addressable', String(nodeRoot?.path))
check(Array.isArray(nodeRoot?.entries) && nodeRoot.entries.length > 0,
  'the node returns folders', `${String((nodeRoot?.entries ?? []).length)} row(s)`)
const nodeRootNames = (nodeRoot?.entries ?? []).map(row => row.name)
check(nodeRootNames.includes('root') || nodeRootNames.includes('etc') || nodeRootNames.includes('home'),
  'and they are the node\'s own, not this machine\'s', nodeRootNames.slice(0, 8).join(','))
const spelled = (nodeRoot?.entries ?? []).every(row => decodePickerPath(row.path)?.nodeId === remote.id)
check(spelled, 'every row is spelled back inside the namespace, so the phone can ask again',
  (nodeRoot?.entries ?? []).slice(0, 3).map(row => row.path).join(' '))
check((nodeRoot?.crumbs ?? [])[0]?.path === PICKER_PREFIX,
  'the crumb row starts at the namespace', JSON.stringify((nodeRoot?.crumbs ?? []).map(c => c.path)))
check((nodeRoot?.crumbs ?? []).length >= 2, 'and reaches into the node', String((nodeRoot?.crumbs ?? []).length))

// A deep listing: the node's home is where a person's projects are.
const deep = await call('directoryPicker/list', { path: `${PICKER_PREFIX}/${remote.id}/root` })
const decoded = decodePickerPath(deep?.path)
check(decoded?.remotePath === '/root', 'one level down decodes to the node path it came from',
  JSON.stringify(decoded))
check((deep?.entries ?? []).every(row => decodePickerPath(row.path)?.remotePath?.startsWith('/root/')),
  'and every child path decodes too', (deep?.entries ?? []).slice(0, 2).map(row => row.path).join(' '))

// A path the node does not have is an error the phone can show, not an empty list.
// The code is `gateway/internal` because the failure came from the node's own shell and
// this Host has no better wire code for it; what matters is that the call *fails* rather
// than answering a plausible empty level.
let missingError
try {
  await call('directoryPicker/list', { path: `${PICKER_PREFIX}/${remote.id}/__rnh_no_such_dir__` })
} catch (error) {
  missingError = error
}
check(missingError !== undefined, 'a folder the node does not have is refused',
  missingError === undefined ? 'it answered a listing' : `${String(missingError.code)}: ${missingError.message.slice(0, 90)}`)

// An offline node must say so rather than answer an empty level: the phone would show
// "this machine has no folders", which reads as a configuration problem.
const unknownId = `n${'0123456789ab'}`
let offlineError
try {
  await call('directoryPicker/list', { path: `${PICKER_PREFIX}/${unknownId}` })
} catch (error) {
  offlineError = error
}
check(offlineError !== undefined, 'a node identity this Host does not record is refused',
  offlineError === undefined ? 'it answered' : String(offlineError.code))

// ---- 3. createDirectory: reachable over the wire, refused for the namespace --
let refused
try {
  await call('directoryPicker/createDirectory', { path: PICKER_PREFIX, name: 'x' })
} catch (error) {
  refused = error
}
check(refused !== undefined, 'a folder cannot be created in the node list itself',
  refused === undefined ? 'it succeeded' : String(refused.code))

// The phone client never sends this call (it is not in DSH Go's endpoint allowlist), but a
// desktop window can, and it must create the folder on the **node**.
const folderName = `rnh-picker-${Date.now().toString(36)}`
let createdPath
try {
  createdPath = await call('directoryPicker/createDirectory', {
    path: `${PICKER_PREFIX}/${remote.id}/tmp`,
    name: folderName,
  })
  check(decodePickerPath(createdPath)?.remotePath === `/tmp/${folderName}`,
    'creating a folder inside a node makes it on that node', String(createdPath))
  const onNode = await nodeExec(`test -d /tmp/${folderName} && echo present || echo absent`)
  check(onNode.trim() === 'present', 'and the node really has it', onNode.trim())
} catch (error) {
  check(false, 'a folder can be created inside a node over the wire', `${String(error.code)} ${error.message}`)
}

// ---- 4. workspace/create by node path, and the shadow it leaves -------------

const workspacePath = `/tmp/${folderName}`
const target = `${PICKER_PREFIX}/${remote.id}${workspacePath}`
// What the relay does before dispatching: `mkdir -p` on the raw request string, in this
// process, so `resolve` here names exactly the directory it made.
const shadow = resolve(target)
mkdirSync(shadow, { recursive: true })
check(existsSync(shadow), 'the relay made a placeholder directory on this machine first', shadow)

const created = await call('workspace/create', { request: { path: target } })
const workspace = created?.workspace ?? created
const workspaceId = workspace?.workspaceId ?? created?.workspaceId
check(typeof workspaceId === 'string' && workspaceId.startsWith(`rnh_${remote.id}_`),
  'the workspace is created on the node and wrapped in a local identity', String(workspaceId))
check(workspace?.path === workspacePath,
  'and carries the node\'s own path, not the namespace spelling', String(workspace?.path))

// The relay made that directory here; the plugin has to remove exactly it.
check(!existsSync(shadow), 'the placeholder the relay created on this machine is gone afterwards', shadow)
const pruned = pruneShadow(target)
check(pruned.removed.length === 0, 'and a second cleanup finds nothing to remove', JSON.stringify(pruned))

// The cleanup must stop at the first directory that has anything in it. A person's file
// under the same tree is the one thing this must never delete — so put one there and ask
// again (the create is idempotent, which is what makes this a second real run).
const keeper = join(shadow, 'notes.md')
mkdirSync(shadow, { recursive: true })
writeFileSync(keeper, 'not the plugin\'s to delete\n')
await call('workspace/create', { request: { path: target } })
check(existsSync(keeper), 'a file somebody put in the placeholder tree survives', keeper)
check(existsSync(shadow), 'and the directory holding it is kept', shadow)
// This test put that file there, so it cleans up the whole reserved root. Nothing else
// lives under it: the sibling checks above proved the plugin removes the empty chain.
rmSync(shadowRootSafe(), { recursive: true, force: true })
check(!existsSync(shadowRootSafe()), 'this machine keeps no placeholder tree after the run', shadowRootSafe())

// A workspace on the node means the node's own Harness registered it, which is the part
// that makes the sidebar and the agent agree.
const listed = await get('/workspaces')
const merged = listed.body.baseline?.items ?? []
check(merged.some(item => item.workspaceId === workspaceId),
  'the merged baseline lists it, so the sidebar shows it', `${String(merged.length)} workspace(s)`)

// ---- 5. the namespace is reserved for nodes -------------------------------

let reserved
try {
  await call('workspace/create', { request: { path: PICKER_PREFIX } })
} catch (error) {
  reserved = error
}
check(reserved !== undefined, 'the namespace itself is not a workspace path',
  reserved === undefined ? 'it created one' : String(reserved.code))

// Clean up: the folder on the node and the workspace record this test made. Leaving either
// behind pollutes every later suite that picks "the first remote workspace" — measured:
// a leftover /tmp fixture became the workspace `approval` drove its prompts in, and its
// first assertion failed for that reason alone.
await call('workspace/delete', { request: { workspaceId } }).catch(error => {
  log(`could not remove the workspace it created: ${String(error.code)} ${error.message}`)
})
await nodeExec(`rmdir /tmp/${folderName}`).catch(() => undefined)

/** The `<drive>:\@rnh` root this machine's namespace resolves to. */
function shadowRootSafe() {
  const one = localShadowOf(`${PICKER_PREFIX}/${remote.id}`)
  return one === undefined ? '' : one.slice(0, one.length - `/${remote.id}`.length)
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
// The carrier's sockets are unref'd, but Node 24 keeps an undici pool alive; exit
// explicitly so a passing run does not hang the runner.
await sleep(250)
process.exit(failures.length === 0 ? 0 : 1)
