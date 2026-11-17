/**
 * Version arithmetic, the release-artefact plan, and the per-plugin sync switches —
 * pure logic, no Host and no node.
 *
 * These three belong together because they answer one question from three angles:
 * *given this desktop and that node, what has to change over there?* Keeping them out
 * of the connection path means the rules can be tested exhaustively (every ordering,
 * every missing field) without a 1.3 GB install or a real SSH session.
 *
 * Run: `node test/version-unit.mjs`
 */
import {
  GATE,
  compareVersions,
  decideGate,
  parseVersion,
  requiresProvisioning,
} from '../src/core/version.js'
import {
  BUILD_STAMP,
  RUNTIME_BUILD,
  artefactName,
  artefactUrls,
  DEFAULT_MIRROR,
  inspectRuntime,
  installScript,
  platformTag,
  rollbackScript,
} from '../src/remote/artefact.js'
import { remoteLayout } from '../src/remote/daemon.js'
import {
  classifyRow,
  isStructuralRow,
  parsePatchRowIds,
  parseSwitches,
  renderSyncBlock,
  resolveSwitches,
  rowsToDisable,
} from '../src/core/plugin-sync.js'

const log = message => process.stdout.write(`[version-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// ---- semver precedence, including the pre-release rules DSH actually uses ------
{
  const order = (a, b) => compareVersions(parseVersion(a), parseVersion(b))
  check(order('0.2.2', '0.2.2') === 0, 'equal versions compare equal')
  check(order('0.2.3', '0.2.2') === 1, 'a patch bump is newer')
  check(order('0.3.0', '0.2.9') === 1, 'a minor bump is newer')
  check(order('1.0.0', '0.99.99') === 1, 'a major bump is newer')
  // A release candidate sorts before its release: this is the case that bites.
  check(order('0.2.2-rc.3', '0.2.2') === -1, 'a release candidate is older than its release')
  check(order('0.2.2-rc.3', '0.2.2-rc.4') === -1, 'rc numbers compare numerically, not as text')
  check(order('0.2.2-rc.10', '0.2.2-rc.9') === 1, 'rc.10 is newer than rc.9 (text order would say otherwise)')
  check(order('0.2.2-rc.3', '0.2.2-beta.1') === 1, 'an rc is newer than a beta')
  check(order('v22.20.0', '22.20.0') === 0, 'a leading v is ignored')
  check(parseVersion('not-a-version') === undefined, 'an unreadable version parses to undefined')
  check(parseVersion(undefined) === undefined, 'a missing version parses to undefined')
  check(parseVersion('0.2.2-rc.3')?.text === '0.2.2-rc.3', 'the text is kept for messages')
}

// ---- the gate: every ordering of host vs node -------------------------------
{
  const at = (host, node, hostBrain = '0.3.0', nodeBrain = '0.3.0') =>
    decideGate({ hostVersion: host, hostBrain, nodeVersion: node, nodeBrain })

  check(at('0.2.2', undefined).action === GATE.INSTALL, 'a node with no runtime gets an install')
  check(at('0.2.2', '0.2.1').action === GATE.INSTALL, 'an older node runtime gets an upgrade')
  check(at('0.2.2', '0.2.1').reason === 'node-runtime-behind', 'and says so',
    at('0.2.2', '0.2.1').reason)
  check(at('0.2.2', '0.2.2').action === GATE.CURRENT, 'a matching pair needs nothing')
  check(at('0.2.2', '0.2.3').action === GATE.AHEAD, 'a newer node runtime is refused')
  check(at('0.2.2', '0.2.3').message.includes('Upgrade the desktop app'),
    'with an instruction the user can act on')
  // A node ahead in *brain build* rather than runtime: another desktop provisioned it.
  check(at('0.2.2', '0.2.2', '0.3.0', '0.4.0').action === GATE.AHEAD,
    'a newer node brain build is refused')
  check(at('0.2.2', '0.2.2', '0.3.0', '0.3.0').action === GATE.CURRENT,
    'an equal brain build is current')
  check(at('0.2.2', '0.2.2', '0.3.0', '0.2.0').action === GATE.REFRESH,
    'an older brain build is refreshed')
  // A missing brain build is the ordinary case right after the desktop upgrades: the
  // node has the runtime but not this plugin's bundle.
  check(decideGate({
    hostVersion: '0.2.2', hostBrain: '0.3.0', nodeVersion: '0.2.2', nodeBrain: undefined,
  }).action === GATE.REFRESH, 'a node with no brain build is refreshed')
  check(at('0.2.2', '0.2.2', '0.3.0', '0.3.0-rc.1').action === GATE.REFRESH,
    'a release candidate brain is older than its release')
  check(at(undefined, '0.2.2').action === GATE.UNKNOWN,
    'an unreadable host version is reported, not guessed')
  check(requiresProvisioning(GATE.INSTALL) && requiresProvisioning(GATE.REFRESH),
    'install and refresh are the provisioning actions')
  check(!requiresProvisioning(GATE.CURRENT) && !requiresProvisioning(GATE.AHEAD),
    'current and ahead are not')
  // Every decision carries a message: the settings page shows it verbatim.
  for (const [host, node] of [['0.2.2', undefined], ['0.2.2', '0.1.0'], ['0.2.2', '0.9.9'], ['0.2.2', '0.2.2']]) {
    const decision = at(host, node)
    check(typeof decision.message === 'string' && decision.message.length > 0,
      `every decision explains itself (${String(node)})`, decision.message.slice(0, 60))
  }
}

// ---- the artefact is per-platform, and the URL goes through the accelerator -----
{
  // The platform tag comes from the *node's* uname, translated to npm's spelling: a
  // runtime packed on Windows cannot run on Linux, because node-pty, sharp and
  // sherpa-onnx ship native binaries.
  check(platformTag({ os: 'Linux', arch: 'x86_64' }) === 'linux-x64',
    'uname says Linux/x86_64; the tag is linux-x64', platformTag({ os: 'Linux', arch: 'x86_64' }))
  check(platformTag({ os: 'Linux', arch: 'aarch64' }) === 'linux-arm64',
    'aarch64 maps to arm64')
  check(platformTag({ os: 'Darwin', arch: 'arm64' }) === 'darwin-arm64', 'Darwin maps to darwin')
  check(platformTag({ os: 'Linux', arch: 'mips' }) === undefined,
    'an unknown architecture has no tag rather than a wrong one')
  check(platformTag({}) === undefined, 'a missing probe result has no tag')
  check(artefactName('0.2.2', 'linux-x64') === 'dsh-0.2.2-linux-x64.tar.gz',
    'the file name carries version and platform', artefactName('0.2.2', 'linux-x64'))

  const urls = artefactUrls({ version: '0.2.2-rc.3', platform: 'linux-x64' })
  check(urls.length === 2, 'two candidate URLs are produced', String(urls.length))
  check(urls[0].startsWith(`${DEFAULT_MIRROR}https://github.com/`),
    'the accelerator is a prefix, not a rewrite', urls[0])
  check(urls[0].endsWith('/releases/download/v0.2.2-rc.3/dsh-0.2.2-rc.3-linux-x64.tar.gz'),
    'the tag and file name carry the version and platform', urls[0].slice(-64))
  check(urls[1] === 'https://github.com/zzyyyds88/dsh-fleet/releases/download/v0.2.2-rc.3/dsh-0.2.2-rc.3-linux-x64.tar.gz',
    'the second candidate is the official URL', urls[1])
  check(new Set(urls).size === 2, 'the candidates are distinct')
  check(artefactUrls({ version: '1.0.0', platform: 'linux-x64', mirror: '' }).length === 1,
    'an empty mirror means "go direct"')
  check(artefactUrls({ version: '1.0.0', platform: 'linux-x64', mirror: 'https://m.example/' })[0]
    .startsWith('https://m.example/https://github.com/'), 'a custom mirror is used verbatim')
  check(artefactUrls({ version: '1.0.0', platform: 'linux-x64', repository: 'a/b', tag: 'nightly' })[0]
    .includes('/a/b/releases/download/nightly/'), 'the repository and tag are configurable')
}

// ---- the install script: what it must contain to be safe --------------------
{
  const script = installScript({
    version: '0.2.2',
    runtime: '/root/.dsh-fleet/runtime',
    cli: '/root/.dsh-fleet/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    urls: ['https://mirror/x.tar.gz', 'https://github/x.tar.gz'],
  })
  check(script.startsWith('set -eu'), 'the install fails fast and stops on error')
  check(script.includes('curl') && script.includes('wget'),
    'it works with either downloader, since a node may have only one')
  check(script.includes('--connect-timeout 15'), 'a hanging download cannot hang the connect')
  check(script.includes('sha256sum') && script.includes('shasum'),
    'it verifies the checksum on either flavour of coreutils')
  check(script.includes('ARTEFACT_CHECKSUM_MISMATCH'), 'and reports a mismatch by name')
  // The script is a template, so the CLI path is already substituted into it: the
  // assertion has to look for the substituted form.
  check(script.includes('node "/root/.dsh-fleet/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" --version'),
    'and the result is verified by running the installed CLI')
  check(script.includes('.incoming'), 'it unpacks into a staging directory')

  const rollback = rollbackScript('/root/.dsh-fleet/runtime')
  check(rollback.includes('.previous') && rollback.includes('rolled-back'),
    'a failed install can be rolled back')
  check(rollback.includes('nothing-to-roll-back'),
    'and reports when there was nothing to roll back to')
}

// ---- per-plugin switches ---------------------------------------------------
{
  check(classifyRow('@deepseek-ai/dsh-client-ui-sidebar').browserOnly,
    'a client-ui row is browser-only')
  check(classifyRow('@deepseek-ai/dsh-web').browserOnly, 'the web shell is browser-only')
  check(classifyRow('@deepseek-ai/dsh-directory-picker').browserOnly,
    'a native dialog is browser-only even though its name does not say so')
  check(classifyRow('@deepseek-ai/dsh-tool-bash').browserOnly === false,
    'a tool is host-plane')
  check(classifyRow('@deepseek-ai/dsh-llm-deepseek-api-key').browserOnly === false,
    'a model adapter is host-plane')
  check(classifyRow(undefined).browserOnly, 'a row with no name is not loadable anywhere')

  const rows = [
    { id: 'sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
    { id: 'bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
    { id: 'picker', name: '@deepseek-ai/dsh-directory-picker' },
  ]
  // The set a real brain composes: dsh-base's rows plus the brain bundle's. The UI
  // rows come from dsh-web-app, which a node does not compose at all.
  const composed = ['bash', 'llm']

  const defaults = resolveSwitches(rows, {}, composed)
  check(defaults.find(row => row.id === 'bash')?.sync === true, 'a composed tool defaults to synced')
  // The bundle list is the default, not a name-shape guess: a node keeps
  // `connection`/`locale`/`resources` and drops every `dsh-client-ui-*` row, and the
  // page has to start out saying exactly that.
  check(defaults.find(row => row.id === 'bash')?.sync === true, 'a composed row defaults to on')
  check(defaults.find(row => row.id === 'sidebar')?.sync === false,
    'a row the node does not compose defaults to unsynced')
  check(defaults.find(row => row.id === 'sidebar')?.present === false,
    'and is marked absent, so the UI does not offer a switch for it')
  check(defaults.every(row => row.source === 'default'), 'with no overrides, every answer is a default')
  check(defaults.find(row => row.id === 'llm')?.reason.includes('host-plane'),
    'a composed row explains itself by what it is', defaults.find(row => row.id === 'llm')?.reason)
  check(defaults.find(row => row.id === 'sidebar')?.reason.includes('does not load'),
    'an absent row says the node does not load it', defaults.find(row => row.id === 'sidebar')?.reason)

  const explicit = resolveSwitches(rows, {
    bash: { sync: false },
    sidebar: { sync: true },
    picker: { sync: true },
    ghost: { sync: false },
  }, composed)
  check(explicit.find(row => row.id === 'bash')?.sync === false,
    'an explicit off beats the default on')
  check(explicit.find(row => row.id === 'bash')?.source === 'explicit', 'and says it was set by hand')
  check(explicit.find(row => row.id === 'ghost') === undefined,
    'a switch for a row that is not composed is ignored')
  // A switch on a row the node does not load is remembered but locked: the intent is
  // kept for when the node does compose it, and the checkbox cannot lie meanwhile.
  const absentOn = explicit.find(row => row.id === 'sidebar')
  check(absentOn?.sync === true && absentOn.locked === true,
    'a switch on an absent row stays locked rather than pretending to apply')

  // Only rows the node composition contains can be disabled: everything else is not in
  // its bundle list, so naming it would be a patch entry about a row that never loads.
  // Measured: one node's patch carried 59 such entries, all of them from dsh-web-app.
  const disabled = rowsToDisable(explicit, composed)
  check(disabled.includes('bash'), 'a hand-disabled composed tool is in the disable list')
  check(!disabled.includes('sidebar'), 'an absent row never is, even when switched on')
  check(!rowsToDisable(explicit, []).includes('bash'),
    'and with an empty composition nothing is disabled at all')
  check(!disabled.includes('web-runtime') && !disabled.includes('brain-runtime'),
    'the node composition itself is never disabled')

  const rendered = renderSyncBlock(explicit, composed)
  check(rendered.includes('- id: bash') && rendered.includes('disabled: true'),
    'the rendered block disables the switched-off row')
  check(rendered.includes('turned off by hand'), 'and marks the hand-made decision')
  check(!rendered.includes('- id: llm'), 'an enabled row does not appear at all')

  // The rows a node cannot start without are locked whatever the composition says.
  const structural = resolveSwitches(
    [{ id: 'web', name: '@deepseek-ai/dsh-web' }, { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver' }],
    { web: { sync: false }, webserver: { sync: false } },
    ['web', 'webserver'],
  )
  check(structural.every(row => row.sync && row.locked),
    'a row a node cannot start without is locked, even after an explicit off')
  check(structural.some(row => row.reason.includes('cannot start')),
    'and the reason says why', structural[0]?.reason)
  check(rowsToDisable(structural, ['web', 'webserver']).length === 0,
    'so nothing structural ever reaches the disable block')
  check(isStructuralRow('web') && isStructuralRow('web-startup') && isStructuralRow('brain-runtime'),
    'the structural set covers the rows measured to be fatal')
  check(!isStructuralRow('office-kit') && !isStructuralRow('workflow-ptc')
    && !isStructuralRow('tool-web') && !isStructuralRow('plan-mode'),
    'and leaves genuinely optional rows switchable')
  // The Remote API itself is structural: with a controller or the transport off, the
  // node still answers HTTP but `session/list` is simply absent — a connected node that
  // cannot list a Session.
  for (const id of ['connection', 'api-remotes', 'file-upload', 'session-controller',
    'terminal-controller', 'workspace-controller', 'workspace-files']) {
    check(isStructuralRow(id), `${id} is structural, because losing it removes the Remote API`)
  }

  // A required-by-name row is not in the brain patch; parsing is how the plugin learns
  // the set without a hand-written list that would go stale on the next upstream sync.
  const ids = parsePatchRowIds([
    '- id: one',
    '  config:',
    '    path: x',
    '- insert:',
    "    - id: two",
    "      name: '@deepseek-ai/x'",
    '- id: three',
  ].join('\n'))
  check(JSON.stringify(ids) === JSON.stringify(['one', 'two', 'three']),
    'patch row ids are read in file order', JSON.stringify(ids))
  check(parsePatchRowIds('').length === 0, 'an empty patch has no rows')
  check(parsePatchRowIds(undefined).length === 0, 'a missing patch has no rows')
  check(parsePatchRowIds('- id: one\n- id: one').length === 1, 'a repeated id is listed once')
  const parsed = parseSwitches({ bash: { sync: false }, llm: true, junk: { sync: 'yes' } })
  check(parsed.bash?.sync === false, 'a stored switch round-trips')
  check(parsed.llm?.sync === true, 'a bare boolean is accepted as a shorthand')
  check(parsed.junk === undefined, 'a non-boolean is dropped rather than guessed')
  check(Object.keys(parseSwitches(undefined)).length === 0, 'a missing file parses to no overrides')
  check(Object.keys(parseSwitches([1, 2])).length === 0, 'a wrongly shaped file is ignored')

  // A row with no entry must never be written as "disabled": that is the difference
  // between a compact settings file and one that freezes today's defaults forever.
  const none = resolveSwitches(rows, {})
  check(rowsToDisable(none, composed).every(id => id === 'sidebar' || id === 'picker'),
    'only the browser rows are disabled when nothing was set by hand',
    rowsToDisable(none, composed).join(','))
  check(rowsToDisable(none, []).length === 0,
    'and with an empty composition nothing is disabled at all')
}

// ---- one node's own filesystem layout, derived from its root ---------------
// Two node records can name the same machine under different roots — the ordinary way
// to test a second node. With one global layout the second node silently reused the
// first one's runtime and resident host, so "two connected nodes" was one node counted
// twice. Measured on one machine before this was fixed.
{
  const first = remoteLayout()
  const defaultAgain = remoteLayout('~/.dsh-fleet')
  const second = remoteLayout('~/.dsh-fleet-b')
  check(first.runtime === '~/.dsh-fleet/runtime', 'the default root keeps its runtime')
  check(first.profile === defaultAgain.profile,
    'the historical root keeps the profile an earlier build created', first.profile)
  check(first.profileName === 'fleet', 'and the profile name a resident host is started with',
    first.profileName)
  check(remoteLayout('~/.dsh-fleet/').profileName === 'fleet', 'a trailing slash changes nothing')
  check(second.runtime === '~/.dsh-fleet-b/runtime', 'a second root gets its own runtime')
  check(second.profileName === 'fleet-b', 'and its own profile name', second.profileName)
  check(second.profile !== first.profile, 'so the two nodes cannot overwrite each other\'s patch',
    `${first.profile} vs ${second.profile}`)
  check(second.run !== first.run && second.status !== first.status,
    'their run directories and status files are distinct too')
  check(remoteLayout('~/.brains/scratch').profileName === 'fleet-scratch',
    'a deeper root names itself after its last segment')
  check(remoteLayout('/').profileName === 'fleet',
    'a root that reduces to nothing falls back rather than colliding silently')
  // Every path a node writes must live under its own root; one that escaped would be
  // the same bug in a different disguise.
  for (const key of ['runtime', 'run', 'log', 'status', 'cli']) {
    check(second[key].startsWith('~/.dsh-fleet-b/'), `${key} lives under the node's own root`, second[key])
  }
  // The Session log lives in the shared DSH home on purpose: two roots on one machine
  // are two brains, not two machines, and each Session record names its own cwd.
  check(second.home === first.home, 'both roots share the machine\'s DSH home', first.home)
}

// ---- the packing build, which the version cannot express -------------------
// A cached artefact is the whole point of the release route, and it also means a tree
// can be the right *version* and the wrong *bytes*: republish the same release with a
// different strip rule and every node that already has it never reinstalls. Measured:
// a strip rule that removed `doc/` also removed `yaml/dist/doc/directives.js`, every
// node from that artefact failed at startup with MODULE_NOT_FOUND, and the gate said
// "current" because the version matched.
{
  const good = inspectRuntime({ version: '0.2.2-rc.3', build: String(RUNTIME_BUILD), wantedVersion: '0.2.2-rc.3' })
  check(good.usable, 'a tree on the right version and the right build is usable', good.reason)
  const repacked = inspectRuntime({ version: '0.2.2-rc.3', build: '1', wantedVersion: '0.2.2-rc.3' })
  check(!repacked.usable, 'a tree packed by an older build is not')
  check(repacked.reason.includes('build 1'), 'and says which build made it', repacked.reason)
  const unstamped = inspectRuntime({ version: '0.2.2-rc.3', build: undefined, wantedVersion: '0.2.2-rc.3' })
  check(!unstamped.usable, 'a tree with no stamp at all is not usable')
  check(!inspectRuntime({ version: '0.1.0', build: String(RUNTIME_BUILD), wantedVersion: '0.2.2-rc.3' }).usable,
    'a tree of another version is not usable either')
  check(!inspectRuntime({ version: undefined, build: undefined, wantedVersion: '0.2.2-rc.3' }).usable,
    'no tree at all is not usable')

  // The gate has to act on that: same version, wrong pack, still a reinstall.
  const decision = decideGate({
    hostVersion: '0.2.2-rc.3',
    hostBrain: '0.3.0',
    nodeVersion: '0.2.2-rc.3',
    nodeBrain: '0.3.0',
    nodeRuntime: repacked.reason,
  })
  check(decision.action === GATE.INSTALL, 'so the gate reinstalls a wrongly packed tree',
    decision.action)
  check(decision.reason === 'node-runtime-repack', 'with a reason that names the cause', decision.reason)
  check(decideGate({
    hostVersion: '0.2.2-rc.3', hostBrain: '0.3.0', nodeVersion: '0.2.2-rc.3', nodeBrain: '0.3.0',
  }).action === GATE.CURRENT, 'and a usable tree still needs nothing')

  // The install script must leave the stamp behind, or every connect reinstalls.
  const script = installScript({
    version: '0.2.2-rc.3',
    runtime: '/root/.dsh-fleet/runtime',
    cli: '/root/.dsh-fleet/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    urls: ['https://mirror/x.tar.gz'],
  })
  check(script.includes(BUILD_STAMP), 'the install writes the build stamp', BUILD_STAMP)
  check(script.includes(`'${String(RUNTIME_BUILD)}'`), 'with the build this plugin packs')
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
