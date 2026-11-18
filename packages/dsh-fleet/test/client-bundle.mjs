/**
 * Prove the browser half actually loads, registers its slots, and renders.
 *
 * A Host-side pass is not enough: the settings page and the sidebar panel are
 * shipped to the browser as a client bundle, and a plugin whose bundle the shell
 * never includes looks perfectly healthy on the Host side. This test fetches the
 * bundle the shell actually serves, executes it in a stubbed module loader, and
 * checks that:
 *
 *   1. the bundle is served and contains this plugin's client code,
 *   2. `apply()` registers exactly the three slots it claims,
 *   3. each registered component renders without throwing.
 *
 * Usage: node test/client-bundle.mjs <hostBase> <launchToken>
 */
import { authenticate, clientBundleFor, get } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/client-bundle.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const PLUGIN_ID = '@zzyyyds88/dsh-fleet/client.js'
const log = message => process.stderr.write(`[client-bundle] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const cookie = await authenticate(base, token)

// ---- 1. the shell serves the bundle --------------------------------------
const bundle = await clientBundleFor(base, cookie, PLUGIN_ID)
check(bundle !== undefined, 'the shell serves a bundle containing this plugin')
if (bundle === undefined) {
  log('FAILED: no bundle lists this plugin')
  process.exit(1)
}
log(`bundle: ${bundle.url.slice(0, 120)}`)
check(bundle.text.includes('远程节点') || bundle.text.includes('Remote nodes'),
  'the bundle carries this plugin’s copy')
check(bundle.text.includes('settings.section'), 'the bundle registers a settings section')

// The index must also name the plugin, otherwise the shell never loads the bundle.
const index = await get(base, cookie, '/')
check(index.text.includes(PLUGIN_ID), 'the Host index names this client plugin')

// ---- 2. the served bundle carries this plugin's source verbatim ----------
// The combo concatenates many plugins into one script, so extracting one balanced
// statement means tokenising JavaScript. Rather than reimplement a parser, compare
// against the file that is the source of truth: if the shipped text contains our
// module word for word, the shell is serving exactly what was written, and the
// local file is what gets executed below.
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const sourcePath = fileURLToPath(new URL('../src/client/client.js', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')
check(bundle.text.includes(source), 'the served bundle contains this plugin’s source verbatim',
  `${String(source.length)} characters`)
check(bundle.text.includes(`id: '@zzyyyds88/dsh-fleet'`), 'the module declares its plugin id')

// ---- 3. execute that module in a stub loader ----------------------------
const registered = []
let factory

/** A tiny React stand-in: enough shape to render without a DOM. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useEffect: () => {},
  useRef: value => ({ current: value }),
}

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: make }) {
      registered.push(id)
      factory = make
    },
  },
}
// Node 22+ exposes `navigator` as a getter-only global; override the property
// descriptor rather than assigning it.
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'zh-CN' },
  })
} catch {
  // A language-neutral default is fine when the global cannot be replaced.
}

let loadError
try {
  // eslint-disable-next-line no-new-func
  new Function(source)()
} catch (error) {
  loadError = error
}
check(loadError === undefined, 'the client module evaluates', loadError?.message?.slice(0, 300))
check(registered.includes('@zzyyyds88/dsh-fleet'), 'the module announces this plugin id',
  registered.join(','))

if (typeof factory !== 'function') {
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}

// ---- 3. apply() registers its slots -------------------------------------
const calls = []
const ctx = {
  slots: {
    inject(name, fn) {
      calls.push({ name, registered: fn() })
    },
    register(registration, component) {
      return { ...registration, component }
    },
  },
}
const mod = factory(specifier => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
check(typeof mod?.apply === 'function', 'the module exports apply()')
mod.apply(ctx)

// The three slots above are this plugin's own surfaces. The three below are the shell's
// folder-picker holes: occupying them is what lets the dialog offer a folder on a node,
// because the shipped pickers browse this machine only.
const FLOW_SLOTS = [
  'sidebar.workspaces.directoryFlow',
  'conversation.hero.workspace.directoryFlow',
  'workspace.picker.directoryFlow',
]
check(calls.length === 3 + FLOW_SLOTS.length, 'apply() registers every slot it claims', String(calls.length))
const names = calls.map(call => call.name)
check(names.includes('settings.section'), 'a settings section is registered')
check(names.includes('sidebar.panellist'), 'a sidebar panel icon is registered')
check(names.includes('main'), 'a main-column page is registered')
for (const slot of FLOW_SLOTS) {
  check(names.includes(slot), `the ${slot} folder picker is replaced`)
}
for (const call of calls) {
  check(typeof call.registered.component === 'function',
    `the ${call.name} slot has a renderable component`)
}

// ---- 4. render each component ------------------------------------------
// Rendering reaches the fleet API, which needs the browser cookie; supply a
// `fetch` that decides by URL so a missing endpoint surfaces as an error.
globalThis.fetch = async url => {
  const path = String(url)
  if (path.includes('/workspaces')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, baseline: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }),
    }
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      version: '0.2.2-rc.3',
      nodes: [{
        id: 'n0123456789ab',
        name: 'test node',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        state: 'connected',
        authKind: 'password',
        credentialsReady: true,
        enabled: true,
      }],
    }),
  }
}

/** Depth-limited render: enough to prove no component throws. */
function render(node, depth = 0) {
  if (depth > 40) return
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    for (const child of node) render(child, depth + 1)
    return
  }
  if (typeof node.type === 'function') {
    render(node.type({ ...node.props, children: node.children }), depth + 1)
    return
  }
  for (const child of node.children ?? []) render(child, depth + 1)
}

for (const call of calls) {
  try {
    render(React.createElement(call.registered.component, {}))
    check(true, `the ${call.name} component renders`)
  } catch (error) {
    check(false, `the ${call.name} component renders`, error.message)
  }
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
// Let undici's pooled sockets settle before the process tears down; exiting with
// a live connection pool trips a libuv assertion on Windows.
await new Promise(resolve => setTimeout(resolve, 250))
process.exit(process.exitCode ?? 0)
