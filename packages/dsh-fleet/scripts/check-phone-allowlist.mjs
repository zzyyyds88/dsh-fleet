#!/usr/bin/env node
/**
 * Compare the phone's allowlist against the Remote endpoints this installation really serves.
 *
 * ## Why this exists
 *
 * `ds-harness-remote` decides what a phone may call from a **client-side constant**
 * (`harnessRemoteAllowlist`). Anything not in it is never sent: the Host side cannot help,
 * and widening a Host allowlist does nothing. So when DSH renames or removes an endpoint,
 * the phone silently loses that capability — no error, no log line, just a button that
 * stops working.
 *
 * That already happened once: the relay lists `subagents/interruptByParent`, while
 * 0.2.2-rc.3 serves `subagents/interruptByUser`, so a phone cannot interrupt a subagent at
 * all. Nobody noticed until the two lists were diffed by hand.
 *
 * ## Why this is a report, not an assertion
 *
 * The two sets are legitimately different in both directions:
 *
 * - the allowlist names endpoints this plugin only *creates at runtime* by decorating an
 *   upstream controller (`workspace/create`, `directoryPicker/list`, …), so a static scan of
 *   `lib/typert.host.js` cannot see them — those are added back from `DECORATED` below;
 * - it also names endpoints of packages a given profile may not compose at all.
 *
 * Measured on 0.2.2-rc.3: allowlist 99, served 90, and 52 of the allowlist entries are not
 * in a static scan. An equality assertion would be red from the first run and get commented
 * out. A report a person reads after an upgrade is what actually catches a rename.
 *
 * Usage:
 *   node scripts/check-phone-allowlist.mjs [--profile desktop] [--asar <path>]
 *
 * Exit codes: 0 report written, 2 the relay plugin or the installation was not found.
 *
 * @module @greatbaby/dsh-fleet/scripts/check-phone-allowlist
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const profile = value('profile', process.env.DSH_PROFILE ?? 'desktop')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)

/**
 * The archive the running installation lives in.
 *
 * `DSH_INSTALL_DIR` is the app's own answer when the script is run from inside the app —
 * it points at `.../app.asar/dsh/node_modules/@deepseek-ai/dsh`, so the archive is three
 * levels up. Without it, fall back to the default install location.
 */
function defaultAsar() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir.length > 0) {
    const derived = join(installDir, '..', '..', '..', '..')
    if (existsSync(derived)) return derived
  }
  return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DSH', 'resources', 'app.asar')
}
const asar = value('asar', defaultAsar())

/**
 * Endpoints this plugin supplies itself by decorating a live controller, so no upstream
 * descriptor names them. Listed here because a report full of false "missing" rows is a
 * report nobody reads.
 */
const DECORATED = Object.freeze([
  'directoryPicker/createDirectory',
  'directoryPicker/list',
  'workspace/create',
])

/** One asar archive opened for member reads. */
function openAsar(path) {
  const fd = openSync(path, 'r')
  const header = Buffer.alloc(16)
  readSync(fd, header, 0, 16, 0)
  const headerSize = header.readUInt32LE(4)
  const body = Buffer.alloc(headerSize)
  readSync(fd, body, 0, headerSize, 8)
  const jsonLength = body.readUInt32LE(4)
  const root = { files: JSON.parse(body.toString('utf8', 8, 8 + jsonLength)).files }
  return {
    /** Walk every file under a prefix, calling `visit(relativePath, node)`. */
    walk(prefix, visit) {
      const segments = prefix.split('/').filter(Boolean)
      let node = root
      for (const segment of segments) {
        node = node?.files?.[segment]
        if (node === undefined) return
      }
      const descend = (current, base) => {
        if (current?.files !== undefined) {
          for (const [key, child] of Object.entries(current.files)) descend(child, `${base}/${key}`)
        } else if (current !== undefined) {
          visit(base, current)
        }
      }
      descend(node, prefix)
    },
    read(node) {
      const buffer = Buffer.alloc(Math.max(0, node.size ?? 0))
      if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, 8 + headerSize + Number(node.offset))
      return buffer.toString('utf8')
    },
    close: () => closeSync(fd),
  }
}

/** `namespace/method` for every descriptor the installed Remote controllers declare. */
function wireEndpointsFromAsar(path) {
  const found = new Set()
  const archive = openAsar(path)
  try {
    archive.walk('/dsh/node_modules/@deepseek-ai', (relative, node) => {
      if (!relative.endsWith('/lib/typert.host.js')) return
      const text = archive.read(node)
      // A **Remote** descriptor carries `service:` and `invocation:`; an event descriptor in
      // the same file is just a payload type (`'turn/start': { turn: number }`). Matching on
      // the entry name alone counted 170 session event types as endpoints the phone could
      // call, which is exactly the noise this report exists to avoid.
      const entries = [...text.matchAll(/'([a-zA-Z]+\/[a-zA-Z]+)':\s*\{/gu)]
      for (const [index, entry] of entries.entries()) {
        const end = entries[index + 1]?.index ?? text.length
        const body = text.slice(entry.index, Math.min(end, entry.index + 2000))
        if (!/\bservice:\s*'[^']+'/u.test(body) || !/\binvocation:\s*\{/u.test(body)) continue
        found.add(entry[1])
      }
    })
  } finally {
    archive.close()
  }
  return found
}

/**
 * The allowlist the relay plugin ships, read out of its built bridge module.
 *
 * Anchored on the array's **contents**, not on its identifier: the constant is spelled
 * differently across relay releases (`HARNESS_REMOTE_ALLOWLIST` in 0.6.5, other names
 * before), but the endpoints it names have to be wire names either way — and the list
 * starts with the two Gateway-internal `$events` entries, which no descriptor declares.
 */
function relayAllowlist(dir) {
  const candidates = [
    join(dir, 'node_modules', 'ds-harness-remote', 'dist', 'harness-remote-bridge.js'),
    join(dir, 'node_modules', '@dsh-remote', 'plugin', 'dist', 'index.js'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const anchor = text.indexOf("'$events/result'")
    if (anchor === -1) continue
    const open = text.lastIndexOf('[', anchor)
    const close = text.indexOf(']', anchor)
    if (open === -1 || close === -1) continue
    const names = [...text.slice(open, close).matchAll(/'(\$?[a-zA-Z]+\/[a-zA-Z]+)'/gu)]
      .map(entry => entry[1])
    if (names.includes('session/prompt') && names.length > 20) {
      return { file, names: [...new Set(names)] }
    }
  }
  return undefined
}

const relay = relayAllowlist(profileDir)
if (relay === undefined) {
  process.stderr.write(
    `no relay plugin found under ${profileDir}\n`
    + 'Install ds-harness-remote into that profile, or pass --profile <name>.\n',
  )
  process.exit(2)
}
if (!existsSync(asar)) {
  process.stderr.write(
    `no DSH installation found at ${asar}\n`
    + 'Pass --asar <path to app.asar>, or set DSH_INSTALL_DIR for an unpacked install.\n',
  )
  process.exit(2)
}

const wire = wireEndpointsFromAsar(asar)
for (const endpoint of DECORATED) wire.add(endpoint)

const allow = new Set(relay.names)
const missing = relay.names.filter(name => !wire.has(name))
const unreachable = [...wire].filter(name => !allow.has(name)).sort()

const log = message => process.stdout.write(`${message}\n`)
log(`relay allowlist : ${String(relay.names.length)} unique endpoints`)
log(`                ${relay.file}`)
log(`served here     : ${String(wire.size)} endpoints (${String(wire.size - DECORATED.length)} from descriptors`
  + ` + ${String(DECORATED.length)} this plugin decorates)`)
log(`dsh             : ${asar}`)
log('')
log(`# In the allowlist, not served here (${String(missing.length)})`)
log('# Endpoints this plugin creates at runtime are already added back, so a name here is one of:')
log('#   - a package this profile does not compose;')
log('#   - a rename upstream already made  ← the kind that costs the phone a capability.')
for (const name of missing) log(`  ${name}`)
log('')
log(`# Served here, the phone may not call it (${String(unreachable.length)})`)
log('# A client-side constant decides this, so the Host side cannot fix it: the remedy is to')
log('# carry the capability on an endpoint the phone does have, or to drop it.')
for (const name of unreachable) log(`  ${name}`)
log('')
log('Read `missing` against the release notes of ds-harness-remote and of DSH, then record')
log('anything real in docs/UPGRADE.zh.md §九. This report is deliberately not an assertion.')