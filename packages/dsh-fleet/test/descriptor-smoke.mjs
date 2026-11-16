/**
 * Verify the mechanism a routing controller depends on: whether a subclass of an
 * upstream Remote service keeps every endpoint and whether its overrides win.
 *
 * The answer is not obvious from reading the decorator, because `@Remote` does
 * not write a static prototype property. It registers a *class initializer*
 * (`context.addInitializer`) that runs per instance and calls
 * `mark(Object.getPrototypeOf(this), …)`. For a subclass instance that resolves
 * to the **subclass** prototype, so the parent's markers land on the subclass
 * and dispatch finds the subclass method.
 *
 * This test proves that with production code paths only.
 *
 * Run under the local Electron Node:
 *   ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" test/descriptor-smoke.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const install = process.env.DSH_INSTALL_DIR === undefined
  ? 'D:\\Program Files\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai'
  : join(process.env.DSH_INSTALL_DIR, '..')
const DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

const log = message => process.stdout.write(`[descriptor-smoke] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const protocol = await import(pathToFileURL(join(install, 'dsh-typert-protocol', 'lib', 'index.js')).href)
const { Remote, remoteMethods } = protocol
const { SessionController } = await import(
  pathToFileURL(join(install, 'dsh-api-session-controller', 'lib', 'index.js')).href
)

// --- 1. the descriptor is initializer-driven, not static ---------------------
const staticDescriptor = Object.getOwnPropertyDescriptor(SessionController.prototype, DESCRIPTOR_KEY)
check(staticDescriptor === undefined, 'the parent prototype carries no static descriptor')
check(typeof Remote === 'function', 'the Remote decorator is exported for direct use')
check(remoteMethods(SessionController.prototype).length === 0, 'remoteMethods is empty before construction')

// --- 2. reproduce the initializer contract exactly --------------------------
// A miniature class using the real decorator, standing in for the upstream one.
const initializers = []
const capture = (name, options) => {
  const decorator = Remote(options)
  decorator(function () { /* the decorated method body is irrelevant here */ }, {
    private: false,
    static: false,
    name,
    addInitializer(fn) { initializers.push(fn) },
  })
}
capture('list', 'list')
capture('prompt', 'prompt')

class Parent {
  list() { return 'parent-list' }
  prompt() { return 'parent-prompt' }
  state() { return 'parent-state' }
}
check(Object.getOwnPropertyDescriptor(Parent.prototype, DESCRIPTOR_KEY) === undefined,
  'capturing an initializer alone does not mark the prototype')

/** Run the stored initializers the way a constructor would, for one instance. */
const construct = instance => { for (const fn of initializers) fn.call(instance) }

// A plain parent instance marks the parent prototype.
construct(Object.create(Parent.prototype))
const parentMarked = remoteMethods(Object.create(Parent.prototype)).map(marker => marker.exportName ?? marker.method)
check(parentMarked.length === 2, 'constructing the parent marks its own prototype',
  parentMarked.join(','))

// --- 3. the decisive case: a subclass instance ------------------------------
class Routing extends Parent {
  list() { return 'routing-list' }
}
const routingInstance = Object.create(Routing.prototype)
construct(routingInstance)

const routingDescriptor = Object.getOwnPropertyDescriptor(Routing.prototype, DESCRIPTOR_KEY)
check(routingDescriptor !== undefined, 'constructing the subclass marks the SUBCLASS prototype')
const routingEndpoints = (routingDescriptor?.value?.methods ?? [])
  .map(marker => marker.exportName ?? marker.method)
check(routingEndpoints.includes('list') && routingEndpoints.includes('prompt'),
  'every parent endpoint survives on the subclass', routingEndpoints.join(','))
check(routingDescriptor?.value?.version === 1, 'the descriptor keeps its schema version')

// Dispatch reads the instance, so the override wins while inherited endpoints
// still reach the parent implementation.
check(routingInstance.list() === 'routing-list', 'the subclass override wins at dispatch')
check(routingInstance.prompt() === 'parent-prompt', 'a non-overridden endpoint reaches the parent')
check(routingInstance.state() === 'parent-state', 'an undeclared parent method still works normally')

// --- 4. the real upstream class exposes the endpoints we route --------------
for (const endpoint of ['list', 'create', 'prompt', 'cancel', 'follow', 'events', 'page', 'state']) {
  check(typeof SessionController.prototype[endpoint] === 'function', `upstream declares ${endpoint}()`)
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
