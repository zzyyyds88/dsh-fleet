/**
 * Which seam does the Gateway dispatch through?
 *
 * Two candidate strategies exist for routing an existing Remote endpoint:
 *
 *   A. Replace the upstream Loader row with a subclass (needs a bundle patch and
 *      an import from inside app.asar).
 *   B. Decorate the live Service instance with own properties (needs nothing but
 *      `ctx.get()`).
 *
 * B is only usable if the Gateway's dispatch — `receiverContext.extend({
 * invocation }).get(key)` then `Reflect.get(view, name)` — still sees an own
 * property defined on the original instance. Cordis returns a *view* bound to the
 * call's Context, so this test builds a real Context and asks the question
 * directly.
 *
 * The plugin is plain JavaScript with no build step, so this test also proves the
 * decorator is not needed: a class marked through the decorator's own initializer
 * contract exposes exactly the same descriptor an upstream class does.
 *
 * Run:
 *   ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" test/dispatch-seam.mjs
 */
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const log = message => process.stdout.write(`[dispatch-seam] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const packages = dirname(process.env.DSH_INSTALL_DIR ?? '')
const cordis = await import(pathToFileURL(join(packages, 'cordis', 'lib', 'index.js')).href)
const protocol = await import(pathToFileURL(join(packages, 'dsh-typert-protocol', 'lib', 'index.js')).href)
const { Context } = cordis
const { Remote, remoteMethods, TypertRemoteService } = protocol

/**
 * Mark one method as a Remote endpoint without decorator syntax.
 *
 * `@Remote` is sugar over `classMethodDecoratorContext.addInitializer`: the
 * initializer runs per instance and marks `Object.getPrototypeOf(instance)`. A
 * plain-JS plugin replays that contract directly.
 * @param {object} prototype
 * @param {string} method
 * @param {string} [exportName]
 */
function markRemote(prototype, method, exportName) {
  const initializers = []
  Remote(exportName ?? method)(function () {}, {
    private: false,
    static: false,
    name: method,
    addInitializer(fn) { initializers.push(fn) },
  })
  const instance = Object.create(prototype)
  for (const fn of initializers) fn.call(instance)
}

// --- a miniature controller shaped exactly like the upstream ones -----------
class SampleController extends TypertRemoteService {
  static inject = []

  constructor(ctx) {
    super(ctx, 'sampleController', { namespace: 'sample' })
  }

  async list(_request, _signal) {
    return { items: [{ sessionId: 'local-1' }] }
  }

  async prompt(request) {
    return { accepted: true, echoed: request }
  }
}
markRemote(SampleController.prototype, 'list', 'list')
markRemote(SampleController.prototype, 'prompt', 'prompt')

const root = new Context()
let controller
try {
  root.plugin({
    name: 'sample',
    apply(ctx) {
      controller = new SampleController(ctx)
    },
  })
} catch (error) {
  log(`plugin registration threw: ${error?.message ?? error}`)
}
if (controller === undefined) {
  // Cordis may defer a fiber's execute until its dependencies settle; an
  // explicit construction isolates the dispatch question from that scheduling.
  log('note: the fiber did not run synchronously; constructing the service directly')
  controller = new SampleController(root)
}
check(controller !== undefined, 'the controller was constructed and registered')

// --- 1. discovery sees the class endpoints ---------------------------------
const live = root.get('sampleController')
check(live !== undefined, 'ctx.get() returns the service')
const endpoints = remoteMethods(live).map(marker => marker.exportName ?? marker.method)
check(endpoints.includes('list') && endpoints.includes('prompt'),
  'remoteMethods() reports the endpoints', endpoints.join(','))

// --- 2. decorate the live instance with own properties ---------------------
let decoratedCalls = 0
Object.defineProperty(live, 'list', {
  configurable: true,
  enumerable: false,
  writable: true,
  value: async function routedList(_request, _signal) {
    decoratedCalls += 1
    return { items: [{ sessionId: 'routed-1' }] }
  },
})
check(Reflect.get(live, 'list') !== SampleController.prototype.list,
  'the own property shadows the prototype method on the instance')

// --- 3. the decisive question: does the Gateway view see it? ---------------
// This reproduces the Gateway's own call path exactly.
const view = root.extend({ invocation: undefined }).get('sampleController')
check(view !== undefined, 'extend({ invocation }).get() returns a view')
const viaView = Reflect.get(view, 'list')
check(typeof viaView === 'function', 'the view exposes the method')

const original = Reflect.get(SampleController.prototype, 'list')
check(viaView !== original, 'the view dispatches to the decorated method, not the class method',
  viaView === original ? 'the view re-resolves from the prototype (strategy B unusable)' : 'own property wins')

if (typeof viaView === 'function') {
  const value = await viaView.call(view, {}, undefined)
  check(value?.items?.[0]?.sessionId === 'routed-1', 'the decorated body actually runs through the view',
    JSON.stringify(value))
  check(decoratedCalls === 1, 'exactly one dispatch reached the override')
}

// --- 4. endpoints NOT decorated still reach the class ----------------------
const promptViaView = Reflect.get(view, 'prompt')
const promptValue = await promptViaView.call(view, { text: 'hello' })
check(promptValue?.echoed?.text === 'hello', 'an undecorated endpoint still works through the view',
  JSON.stringify(promptValue))

// --- 5. discovery is unaffected after decoration --------------------------
const after = remoteMethods(live).map(marker => marker.exportName ?? marker.method)
check(after.length === endpoints.length, 'decoration does not change the declared endpoint set',
  `${String(after.length)} vs ${String(endpoints.length)}`)

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
