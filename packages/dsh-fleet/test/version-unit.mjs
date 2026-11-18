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
  FETCH_CEILING_SECONDS,
  FETCH_FLOOR_BYTES,
  FETCH_FLOOR_SECONDS,
  inspectRuntime,
  installScript,
  platformTag,
  rollbackScript,
} from '../src/remote/artefact.js'
import { remoteLayout } from '../src/remote/daemon.js'
import {
  installedPlugins,
  isLocalSpec,
  isNeverSynced,
  isThirdParty,
  nodeBundles,
  parseSwitches,
  resolvePlugins,
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
  // A dead fallback must give up on its own: measured on the test node, the mirror pulled
  // the whole 170 MiB archive in 4 s while the direct GitHub fallback managed 925 KB in
  // 30 s. Without a floor the install sat there for over an hour, which the user sees as
  // "connecting hangs" with nothing to report.
  check(script.includes(`--speed-limit ${FETCH_FLOOR_BYTES}`)
    && script.includes(`--speed-time ${FETCH_FLOOR_SECONDS}`),
  'and a download that stalls gives up instead of running forever')
  check(script.includes(`--max-time ${FETCH_CEILING_SECONDS}`),
    'while a slow but working line still gets a real budget')
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
// ---- which of your plugins a node loads ------------------------------------
// The unit of a switch is a **bundle**, not a row. The row list this used to test had
// 207 entries — one per internal service — and only a handful of them were decisions a
// person could make. A node composes a bundle list, so one switch per installed bundle is
// the model that can actually be carried out.
{
  const manifest = {
    dependencies: {
      '@deepseek-ai/dsh-base': '0.2.2-rc.3',
      '@local/dsh-fleet-brain': '0.1.0',
      'dsh-pet': '^0.4.9',
      '@artenx/dshb': '^1.2.0',
      'left-pad': '^1.0.0',
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-pet',
          '@local/dsh-fleet-brain',
          '@artenx/dshb',
        ],
      },
    },
  }

  check(isThirdParty('dsh-pet'), 'a bare npm package is a plugin you installed')
  check(isThirdParty('@artenx/dshb'), 'so is a scoped third party')
  check(!isThirdParty('@deepseek-ai/dsh-base'), 'an upstream bundle is not a choice')
  check(!isThirdParty('@deepseek-ai/dsh-web-app'), 'a node is a subtraction from dsh-web-app')
  check(!isThirdParty('@local/dsh-fleet-brain'), 'the brain bundle is how a node becomes one')
  check(!isThirdParty('@local/dsh-fleet'), 'and this desktop half is not something to send')
  check(!isThirdParty(''), 'an empty name is not a plugin')

  // Never-sync is its own answer: it asks "may this reach a node at all", which the
  // product/third-party question cannot decide. Each name is here for a different reason,
  // so a prefix rule would be wrong in one direction or the other.
  check(isNeverSynced('@local/dsh-fleet'),
    'this desktop half holds the node-management tool: a node that ran it could manage other nodes')
  check(isNeverSynced('ds-harness-remote'), 'a relay plugin on a node would open a second way in')
  check(isNeverSynced('@dsh-remote/plugin'), 'and the older name for the same thing')
  check(isNeverSynced('@local/dsh-fleet-brain'), 'the brain bundle is already the node side')
  check(!isNeverSynced('dsh-pet'), 'an ordinary plugin is not on the list')
  check(!isNeverSynced(undefined), 'and neither is a missing name')

  // A desktop whose profile lists the relay must not offer it as a switch, and must not
  // report it as "installed but not loaded" either: the name never becomes a row.
  const relayed = installedPlugins({
    dependencies: { 'dsh-pet': '^0.4.9', 'ds-harness-remote': '^0.6.5', '@local/dsh-fleet': 'link:packages/dsh-fleet' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-pet', 'ds-harness-remote', '@local/dsh-fleet'] } },
  })
  check(relayed.map(row => row.bundle).join(',') === 'dsh-pet',
    'the hard exclusions never reach the switch list', relayed.map(row => row.bundle).join(','))

  // Loaded bundles first, then installed-but-not-loaded: a person reads "what a node
  // gets" at the top, and a package that is downloaded but not loaded here keeps its row
  // instead of vanishing from the page.
  const plugins = installedPlugins(manifest, name => (name === 'dsh-pet' ? ['dsh-pet'] : []))
  check(plugins.map(plugin => plugin.bundle).join(',') === 'dsh-pet,@artenx/dshb,left-pad',
    'installed plugins are listed, upstream and the brain excluded', plugins.map(p => p.bundle).join(','))
  check(plugins[0].loaded === true, 'a bundle in the profile list is marked as loaded here')
  check(plugins[0].spec === '^0.4.9', 'its install spec comes from the manifest, not from a guess')
  check(JSON.stringify(plugins[0].rows) === '["dsh-pet"]',
    'and the rows it contributes are read from its own patch', JSON.stringify(plugins[0].rows))
  check(plugins[2].loaded === false, 'a dependency that is not in the bundle list is not loaded here')
  check(plugins[2].rows.length === 0, 'and contributes no rows, because it was never read')

  // The default is **on**. A switch means "this plugin also runs on that machine", and a
  // person who installed a plugin here and connected a node asked for one working
  // environment rather than a second one that silently differs. The exclusions above are
  // what keep "on" from meaning "and so does the desktop half of this plugin".
  const defaults = resolvePlugins(plugins, {})
  check(defaults.every(row => row.sync === true), 'your plugins are sent by default')
  check(defaults.every(row => row.source === 'default'), 'with no overrides, every answer is a default')
  check(defaults[0].reason.includes('sent unless turned off'),
    'a loaded plugin explains what happens by default', defaults[0].reason)
  check(defaults[2].reason.includes('not loaded'), 'an unloaded one says so', defaults[2].reason)

  // Turning one off is the only thing to undo, exactly as turning one on used to be.
  const chosen = resolvePlugins(plugins, { '@artenx/dshb': { sync: false } })
  check(chosen.find(row => row.bundle === '@artenx/dshb')?.sync === false, 'an explicit off is honoured')
  check(chosen.find(row => row.bundle === '@artenx/dshb')?.source === 'explicit',
    'and says the person decided it')
  check(chosen.find(row => row.bundle === 'dsh-pet')?.sync === true,
    'a plugin nobody touched keeps the default')

  // The node's bundle list keeps the brain last: bundles compose in order and the brain
  // patch has to land over upstream's. The chosen plugins sit between them, so a plugin
  // extends the brain rather than replace it.
  const list = nodeBundles(['@deepseek-ai/dsh-base', '@local/dsh-fleet-brain'], chosen)
  check(JSON.stringify(list) === JSON.stringify([
    '@deepseek-ai/dsh-base', 'dsh-pet', 'left-pad', '@local/dsh-fleet-brain',
  ]), 'the node list is base, then your plugins, then the brain', JSON.stringify(list))
  check(nodeBundles(['@deepseek-ai/dsh-base', '@local/dsh-fleet-brain'],
    resolvePlugins([], {})).length === 2,
  'with no plugins installed a node is exactly the brain')

  // A corrupt switches file means "no opinions yet", never "send everything".
  const parsed = parseSwitches({
    'dsh-pet': { sync: true },
    '@artenx/dshb': { sync: false },
    junk: { sync: 'yes' },
  })
  check(parsed['dsh-pet']?.sync === true, 'a stored switch round-trips')
  check(parsed.junk === undefined, 'a non-boolean is dropped rather than guessed')
  check(Object.keys(parseSwitches(undefined)).length === 0, 'a missing file parses to no overrides')
  check(Object.keys(parseSwitches([1, 2])).length === 0, 'a wrongly shaped file is ignored')

  // How a plugin travels depends on this one answer, and getting it wrong is a silent
  // 404 on somebody's server: a local bundle has no registry entry, so `npm install` there
  // cannot work and the files have to be copied instead.
  check(isLocalSpec('link:C:/Users/x/.dsh/local-bundles/rhino-mode'), 'a link: dependency is a local bundle')
  check(isLocalSpec(undefined), 'a bundle with no recorded spec is local, not "publish latest"')
  check(!isLocalSpec('^1.2.0'), 'a caret range is published')
  check(!isLocalSpec('0.3.17'), 'an exact version is published')
  check(!isLocalSpec('latest'), 'a dist-tag is published')
  check(isLocalSpec('file:../plugin'), 'a file: dependency is local')
  check(isLocalSpec('./plugin'), 'a relative path is local')
  check(isLocalSpec('D:\\ProjectHub\\DSHpl\\packages\\dsh-fleet'), 'a Windows path is local')
  check(isLocalSpec('/opt/plugins/x'), 'an absolute POSIX path is local')
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
