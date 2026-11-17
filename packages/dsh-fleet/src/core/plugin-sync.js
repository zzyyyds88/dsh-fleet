/**
 * Which of **your** plugins go to a node.
 *
 * The switch list used to be every row this desktop composes — 207 of them, one per
 * internal service and tool. That is the wrong unit: a person installs *plugins*, not
 * rows, and almost every row belongs to a package a node already has. A page with 207
 * toggles describes the composition; it does not let anyone decide anything.
 *
 * The unit here is the **bundle**: the packages this desktop installed and added to its
 * own `dsh.profile.bundles`. A node can load exactly that list, so one switch means
 * "install and load this plugin there", which is a decision a person can actually make
 * and which this plugin can actually carry out.
 *
 * Upstream bundles are excluded because a node composes them by construction — `dsh-base`
 * is what a brain is built on, and `dsh-web-app` is the surface a brain is a subtraction
 * from. This plugin's own bundle is excluded too: it is how the node becomes a brain, not
 * something to switch off.
 *
 * @module @local/dsh-fleet/core/plugin-sync
 */

/** Bundles a node always composes, so they are never a choice. */
export const UPSTREAM_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
])

/** This plugin's node-side bundle: the thing that makes a node a brain. */
export const BRAIN_PACKAGE = '@local/dsh-fleet-brain'

/**
 * Whether a bundle is one a person installed rather than part of the product.
 *
 * The prefix rules are deliberate: `@deepseek-ai/*` is upstream, `@local/*` is what this
 * repository builds. Everything else — a scoped third party or a bare npm name — is a
 * plugin the user added, which is exactly the set that should be switchable.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isThirdParty(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (UPSTREAM_BUNDLES.includes(name)) return false
  if (name === BRAIN_PACKAGE) return false
  if (name.startsWith('@deepseek-ai/')) return false
  // `@local/dsh-fleet` is the desktop half of this plugin, and `@local/dsh-fleet-brain` is
  // handled above; any other `@local/*` package is a user's own local bundle.
  if (name === '@local/dsh-fleet') return false
  return true
}

/**
 * The plugins this desktop installed, in the order its profile lists them.
 *
 * Both facts come from the **profile manifest**, which is where DSH records them:
 * `dependencies` says what is installed and at what spec, `dsh.profile.bundles` says what
 * is actually loaded. A package in `dependencies` but not in `bundles` is installed and
 * not loaded here; it is reported so the page can show it rather than silently dropping
 * it, and it defaults to off — a node should receive what this desktop loads, not
 * everything it happens to have downloaded.
 *
 * @param {{ dependencies?: Record<string, string>, dsh?: { profile?: { bundles?: unknown } } } | undefined} manifest
 * @param {(name: string) => string[]} rowsOf - row ids one bundle contributes, if known.
 * @returns {Array<{ bundle: string, spec: string, rows: string[], loaded: boolean }>}
 */
export function installedPlugins(manifest, rowsOf = () => []) {
  const dependencies = manifest?.dependencies ?? {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter(name => typeof name === 'string')
    : []
  const names = []
  for (const name of bundles) {
    if (isThirdParty(name) && !names.includes(name)) names.push(name)
  }
  // Installed-but-not-loaded goes after, so the list reads "what a node gets" first.
  for (const name of Object.keys(dependencies)) {
    if (isThirdParty(name) && !names.includes(name)) names.push(name)
  }
  return names.map(bundle => ({
    bundle,
    spec: typeof dependencies[bundle] === 'string' ? dependencies[bundle] : '',
    rows: rowsOf(bundle),
    loaded: bundles.includes(bundle),
  }))
}

/**
 * Resolve every plugin's switch, and say where the answer came from.
 *
 * `source` matters in the UI: "you turned this on" and "this is on because it is one of
 * your plugins" are different facts, and only the first is something to undo.
 *
 * The default is **off**. A node is a different machine with its own job, and a plugin
 * arrives with its own dependencies and side effects; sending it because it happens to be
 * installed here would mean every new plugin silently lands on every node. So the page
 * starts out sending nothing, and each switch is a deliberate yes.
 *
 * @param {ReturnType<typeof installedPlugins>} plugins
 * @param {Record<string, { sync: boolean }>} overrides - persisted per-bundle choices.
 * @returns {Array<{ bundle: string, spec: string, rows: string[], loaded: boolean, sync: boolean, source: 'default' | 'explicit', reason: string }>}
 */
export function resolvePlugins(plugins, overrides) {
  return plugins.map(plugin => {
    const explicit = overrides[plugin.bundle]
    if (explicit !== undefined) {
      return {
        ...plugin,
        sync: explicit.sync,
        source: 'explicit',
        reason: explicit.sync ? 'sent by hand' : 'turned off by hand',
      }
    }
    return {
      ...plugin,
      sync: false,
      source: 'default',
      reason: plugin.loaded
        ? 'installed here; decide per node'
        : 'installed here but not loaded by this desktop',
    }
  })
}

/**
 * The bundle list a node's profile should carry.
 *
 * Order matters to DSH: bundles compose in list order, and this plugin's brain bundle must
 * come last so its patch is applied over upstream's. The third-party plugins sit between
 * the two, because they extend the brain rather than replace it.
 *
 * @param {readonly string[]} base - the bundles a node composes by construction.
 * @param {Array<{ bundle: string, sync: boolean }>} resolved
 * @returns {string[]}
 */
export function nodeBundles(base, resolved) {
  const extra = resolved.filter(row => row.sync === true).map(row => row.bundle)
  const last = base.at(-1)
  const head = last === BRAIN_PACKAGE ? base.slice(0, -1) : [...base]
  return [...head, ...extra, ...(last === BRAIN_PACKAGE ? [BRAIN_PACKAGE] : [])]
}

/**
 * Whether a dependency spec names a directory on this machine rather than a registry
 * entry.
 *
 * Three shapes mean the same thing, all measured:
 *
 * - `link:` — how DSH records a bundle a person wrote;
 * - `file:` or a plain path — npm's own "this is on disk" forms;
 * - **no spec at all** while the package is nonetheless in `node_modules`. A profile can
 *   carry a linked bundle whose `dependencies` entry an earlier tool never wrote (the
 *   `fleettest` profile did), and treating that as published means running
 *   `npm install @local/x` on a node, which is a guaranteed 404.
 *
 * The consequence matters: a local plugin travels by **copying its files**, not by npm.
 * @param {string | undefined} spec
 * @returns {boolean}
 */
export function isLocalSpec(spec) {
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (text.length === 0) return true
  if (text.startsWith('link:') || text.startsWith('file:') || text.startsWith('.')) return true
  // An absolute POSIX path or a Windows drive path is a directory too.
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(text)
}

/**
 * Read the saved switches.
 *
 * Only `true`/`false` survive: a corrupt file should mean "no opinions yet" (everything
 * off) rather than a node that receives a package nobody asked for.
 *
 * @param {unknown} value
 * @returns {Record<string, { sync: boolean }>}
 */
export function parseSwitches(value) {
  if (value === null || typeof value !== 'object') return {}
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const sync = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'sync') : undefined
    if (typeof sync === 'boolean') out[key] = { sync }
  }
  return out
}
