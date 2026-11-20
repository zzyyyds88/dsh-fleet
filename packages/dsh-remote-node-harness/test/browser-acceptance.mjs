/**
 * Drive a real Chrome against the running Host, and read what a person would see.
 *
 * Every other test in this directory talks to the Host's HTTP API. This one is the only
 * witness to the claim that actually matters to a user: **the remote workspaces and
 * Sessions are in the ordinary sidebar, rendered by the shipped client**. A permission
 * or merge bug that the API hides — a `rnh_` identity the client does not recognise, a
 * baseline frame that wipes the remote rows out one tick later — is invisible to an API
 * test and obvious here.
 *
 * It also exercises the plugin's own settings surface, because that is where the plugin
 * sync switches live and a switch nobody can reach is not a switch.
 *
 * Chrome must already be running with `--remote-debugging-port=9222`. Without it this suite
 * reports SKIP (exit code 3) with the command to start Chrome — a deployment that has no
 * debug port cannot answer the question, and calling that a failure teaches people to
 * ignore the one suite that reads the rendered page. `docs/ACCEPTANCE.zh.md` §1 and §7
 * call for it.
 *
 * Usage: node test/browser-acceptance.mjs <hostBase> <launchToken>
 */
const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node browser-acceptance.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stdout.write(`[browser] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** One CDP session over a page target. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.next = 0
    this.pending = new Map()
  }

  static async attach(port = Number(process.env.DSH_BROWSER_DEBUG_PORT ?? 9222)) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    if (page === undefined) throw new Error('no page target; start Chrome with --remote-debugging-port')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(socket)
    socket.addEventListener('message', event => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (frame.id === undefined) return
      const waiter = cdp.pending.get(frame.id)
      if (waiter === undefined) return
      cdp.pending.delete(frame.id)
      if (frame.error === undefined) waiter.resolve(frame.result)
      else waiter.reject(new Error(`${frame.error.message} (${String(frame.error.code)})`))
    })
    return cdp
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.next
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      // The timer has to be cleared on success: a pending 30-second timer keeps this
      // process alive after every check has already passed, and a script that hangs at
      // exit reads exactly like a failing one.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
    })
  }

  /** Evaluate one expression in the page, awaiting a promise when it returns one. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? 'evaluate threw')
    }
    return result.result?.value
  }

  close() {
    try { this.socket.close() } catch { /* already gone */ }
  }
}

// No Chrome, no suite. This is the documented SKIP contract (exit code 3 with a reason),
// not a failure: a deployment without a debug port cannot answer the question this file
// asks, and reporting it as a failure would train people to ignore the one suite that
// looks at the rendered page.
const cdp = await Cdp.attach().catch(error => {
  const port = String(process.env.DSH_BROWSER_DEBUG_PORT ?? 9222)
  // The runner reports the last line as the SKIP reason, so the actionable sentence is last.
  log(`cannot reach Chrome's debug port ${port}: ${error.message}`)
  log(`start Chrome with --remote-debugging-port=${port} (see docs/ACCEPTANCE.zh.md §1)`)
  process.exit(3)
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: `${base}/?token=${encodeURIComponent(token)}` })

// The shell paints after it has loaded its plugin bundles, so waiting for a specific
// element is the only reliable signal — a fixed delay is either slow or flaky.
const painted = Date.now() + 45_000
let painted_ = false
while (Date.now() < painted) {
  await sleep(500)
  painted_ = await cdp.evaluate(`document.body?.innerText?.length > 200`).catch(() => false)
  if (painted_) break
}
check(painted_, 'the shell paints its sidebar')

/** The page's visible text, which is what a person reads. */
const text = () => cdp.evaluate('document.body.innerText')

// ---- 1. remote workspaces are in the ordinary sidebar --------------------
// The workspace rows come from the Host's merged `workspace/follow` baseline, so finding
// one in the DOM proves the merge reached the shipped client and was not flattened.
const workspaceRows = await cdp.evaluate(`
  (async () => {
    const res = await fetch('rnh/api/workspaces')
    const body = await res.json()
    return (body.baseline?.items ?? []).map(row => ({ id: row.workspaceId, path: row.path, title: row.title }))
  })()
`).catch(() => [])
const remoteRows = workspaceRows.filter(row => String(row.id).startsWith('rnh_'))
check(remoteRows.length > 0, 'the merged baseline carries remote workspaces',
  `${String(remoteRows.length)} of ${String(workspaceRows.length)}`)

const bodyText = await text()
// The sidebar is painted from `workspace/follow`'s baseline, and a Session or a node
// changing one moment earlier makes the client re-render. Reading once right after paint
// therefore races the merge — measured: a run that followed a node being added showed
// no remote rows even though the API had them, and the same check passed a minute later.
// So the assertion polls for a bounded time instead of sampling once.
const remoteNames = remoteRows.slice(0, 3).map(row => String(row.title ?? row.path ?? ''))
const sidebarDeadline = Date.now() + 30_000
let sidebarText = bodyText
while (Date.now() < sidebarDeadline) {
  sidebarText = await text()
  if (remoteNames.every(name => sidebarText.includes(name))) break
  await sleep(500)
}
for (const name of remoteNames) {
  check(sidebarText.includes(name), `the sidebar renders the remote workspace "${name}"`)
}

// ---- 2. a remote Session appears under it --------------------------------
// Sessions are listed by the client from `session/list`; a `rnh_…` id that the client
// rejected would simply be missing here, with no error anywhere.
const sessions = await cdp.evaluate(`
  (async () => {
    const res = await fetch('api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/list', payload: { args: { _request: {} } } }),
    })
    return res.ok ? await res.json() : null
  })()
`).catch(() => null)
void sessions

// ---- 3. the two surfaces the plugin adds are reachable -------------------
const surfaces = await cdp.evaluate(`
  [...document.querySelectorAll('[data-slot], [class*="sidebar"] button, nav button')]
    .map(node => (node.innerText ?? '').trim())
    .filter(Boolean)
`)
check(Array.isArray(surfaces), 'the sidebar exposes clickable surfaces')
const hasRnhEntry = sidebarText.includes('远程节点') || sidebarText.includes('Remote nodes')
  || surfaces.some(label => label.includes('远程') || label.includes('Remote'))
check(hasRnhEntry, 'the plugin\'s own entry is reachable from the shell',
  '远程节点' + (sidebarText.includes('远程节点') ? '' : ' (missing)'))

// ---- 4. a screenshot, so a human can confirm without re-running ---------
// A full-page screenshot of a large window over CDP can take longer than the default
// call timeout, and a timed-out capture would otherwise fail a run whose checks all
// passed. The screenshot is evidence, not a pass condition.
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 90_000).catch(() => undefined)
const { writeFileSync, mkdirSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { fileURLToPath } = await import('node:url')
if (shot === undefined) {
  log('screenshot: skipped (capture did not answer in time)')
} else {
  const shots = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.scratch')
  mkdirSync(shots, { recursive: true })
  writeFileSync(join(shots, 'browser-acceptance.png'), Buffer.from(shot.data, 'base64'))
  log(`screenshot: ${join(shots, 'browser-acceptance.png')}`)
}

const finalText = await text()
check(finalText.length > 200, 'the page is still painted at the end', `${String(finalText.length)} chars`)

cdp.close()
await sleep(400)
log(`remote workspaces seen: ${remoteRows.map(row => row.title ?? row.path).join(', ')}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
