/**
 * `host/picker-paths.js` — the `/@fleet/<nodeId>/…` namespace a Remote caller speaks.
 *
 * Three properties matter and each one has a way of breaking that is invisible until a
 * phone is involved: the encoding has to survive the relay's two path normalisers, the
 * decoding has to name exactly one node, and the cleanup must be unable to delete a
 * directory a person made.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PICKER_PREFIX,
  decodePickerPath,
  encodePickerPath,
  isPickerPath,
  localShadowOf,
  normalizePickerPath,
  pruneShadow,
  pruneShadowTree,
} from '../src/host/picker-paths.js'

const nodeA = 'n0123456789ab'
const nodeB = 'nba9876543210'

let failed = 0
const checks = []
function ok(condition, message, detail) {
  checks.push({ condition, message, detail })
  if (!condition) failed += 1
  const mark = condition ? 'ok  ' : 'FAIL'
  console.log(`[picker-paths] ${mark} ${message}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---- encoding -------------------------------------------------------------

ok(encodePickerPath(nodeA, '/') === `${PICKER_PREFIX}/${nodeA}`, 'a node root is the namespace plus its identity', encodePickerPath(nodeA, '/'))
ok(encodePickerPath(nodeA, '') === `${PICKER_PREFIX}/${nodeA}`, 'an empty path means the same root', encodePickerPath(nodeA, ''))
ok(encodePickerPath(nodeA, '/root') === `${PICKER_PREFIX}/${nodeA}/root`, 'a child drops exactly one leading separator', encodePickerPath(nodeA, '/root'))
ok(encodePickerPath(nodeA, '/root/proj/') === `${PICKER_PREFIX}/${nodeA}/root/proj`, 'a trailing separator is trimmed so a path round-trips unchanged', encodePickerPath(nodeA, '/root/proj/'))
ok(encodePickerPath(nodeA, '/@fleet') === `${PICKER_PREFIX}/${nodeA}/@fleet`, 'a real /@fleet directory on the node is still spellable', encodePickerPath(nodeA, '/@fleet'))

let threw = false
try { encodePickerPath('nope', '/root') } catch { threw = true }
ok(threw, 'a malformed node identity is refused rather than producing an undecodable path')

// ---- decoding -------------------------------------------------------------

const cases = [
  [`${PICKER_PREFIX}`, { kind: 'nodes' }, 'the namespace itself lists nodes'],
  [`${PICKER_PREFIX}/`, { kind: 'nodes' }, 'a trailing separator still means the node list'],
  [`${PICKER_PREFIX}/${nodeA}`, { kind: 'node', nodeId: nodeA, remotePath: '/' }, 'a bare node identity is its root'],
  [`${PICKER_PREFIX}/${nodeA}/`, { kind: 'node', nodeId: nodeA, remotePath: '/' }, 'a trailing separator after the identity is still the root'],
  [`${PICKER_PREFIX}/${nodeA}/root/proj`, { kind: 'node', nodeId: nodeA, remotePath: '/root/proj' }, 'a child keeps its leading separator on the node side'],
  [`${PICKER_PREFIX}/${nodeA}/@fleet`, { kind: 'node', nodeId: nodeA, remotePath: '/@fleet' }, 'the nested /@fleet is node data, not the namespace'],
]
for (const [input, expected, message] of cases) {
  const actual = decodePickerPath(input)
  ok(JSON.stringify(actual) === JSON.stringify(expected), message, JSON.stringify(actual))
}

// The relay and a Windows client each normalise separators differently; the namespace
// has to survive both or a phone round-trip silently becomes "not a node path".
ok(decodePickerPath('\\@fleet\\n0123456789ab\\root')?.remotePath === '/root', 'backslashes are normalised before decoding', JSON.stringify(decodePickerPath('\\@fleet\\n0123456789ab\\root')))
ok(decodePickerPath('D:/@fleet/n0123456789ab/root')?.remotePath === '/root', 'a Windows drive prefix is stripped', JSON.stringify(decodePickerPath('D:/@fleet/n0123456789ab/root')))
ok(decodePickerPath('/@fleet//n0123456789ab//root')?.remotePath === '/root', 'repeated separators collapse', JSON.stringify(decodePickerPath('/@fleet//n0123456789ab//root')))
ok(decodePickerPath('/@FLEET/n0123456789ab') !== undefined, 'the namespace match is case-insensitive on a Windows client')
ok(decodePickerPath('/@fleet/nOTANODE') === undefined, 'an identity that is not n+12hex is not a node path')
ok(decodePickerPath('/@fleet/n0123456789abx/root') === undefined, 'a longer identity does not half-match')
ok(decodePickerPath('/root/proj') === undefined, 'an ordinary path is not in the namespace')
ok(decodePickerPath(undefined) === undefined, 'an absent path is not in the namespace')
ok(decodePickerPath(null) === undefined, 'a null path is not in the namespace')
ok(decodePickerPath(42) === undefined, 'a non-string is not in the namespace')
ok(isPickerPath(`${PICKER_PREFIX}/${nodeB}`) && !isPickerPath('/@fleets'), 'the prefix matches whole segments only')

ok(normalizePickerPath('  /root  ') === '/root', 'surrounding whitespace is trimmed')
ok(normalizePickerPath('/') === '/', 'the filesystem root survives normalisation')

// ---- the shadow directory -------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), 'fleet-picker-'))
try {
  const shadow = localShadowOf(`${PICKER_PREFIX}/${nodeA}/root/proj`)
  ok(typeof shadow === 'string', 'a node path has a computable local shadow', shadow)
  ok(shadow !== undefined && shadow.includes('@fleet'), 'the shadow lives inside the reserved tree', shadow)
  ok(localShadowOf('/root/proj') === undefined, 'an ordinary POSIX path has no shadow this plugin owns')

  // The walk itself is exercised inside a temporary root: the real one is
  // `<drive>:\@fleet`, and a test must never create or delete directories there.
  const root = join(sandbox, '@fleet')
  const chain = join(root, nodeA, 'root', 'proj')

  // A just-created chain: everything the relay's `mkdir -p` made is empty, so all of it goes.
  mkdirSync(chain, { recursive: true })
  const pruned = pruneShadowTree(chain, root)
  ok(pruned.removed.length === 4, 'the empty chain is removed from the deepest directory up', String(pruned.removed.length))
  ok(!existsSync(chain), 'the created directory is gone', chain)
  ok(!existsSync(root), 'and so is the reserved root it was created under')

  // A directory the user put something in must stop the walk, not be removed.
  mkdirSync(chain, { recursive: true })
  writeFileSync(join(chain, 'notes.md'), 'x')
  const stopped = pruneShadowTree(chain, root)
  ok(stopped.removed.length === 0, 'a non-empty directory is never removed', JSON.stringify(stopped))
  ok(existsSync(chain), 'the non-empty directory is still there', chain)
  ok(statSync(join(chain, 'notes.md')).isFile(), 'and the file inside it is untouched')
  rmSync(join(root, nodeA), { recursive: true, force: true })

  // Only empty directories the relay made, no more: a file higher up stops it too.
  const deep = join(root, nodeB, 'a', 'b', 'c')
  mkdirSync(deep, { recursive: true })
  const keeper = join(root, nodeB, 'a', 'keep.txt')
  writeFileSync(keeper, 'x')
  const secondPass = pruneShadowTree(deep, root)
  ok(secondPass.removed.length === 2, 'the walk stops below the first directory with content in it', String(secondPass.removed.length))
  ok(existsSync(keeper), 'the sibling file survives')
  ok(!existsSync(deep), 'and the empty tail below it is gone')
  ok(existsSync(join(root, nodeB, 'a')), 'the directory holding it is kept')

  // A start path outside the root is refused even when it exists and is empty.
  const outside = join(sandbox, 'precious')
  mkdirSync(outside)
  const untouched = pruneShadowTree(outside, root)
  ok(untouched.removed.length === 0 && existsSync(outside), 'a directory outside the reserved root is refused', JSON.stringify(untouched))

  // The production entry point refuses a path that is not in the namespace at all.
  const plain = pruneShadow('/root/proj')
  ok(plain.removed.length === 0, 'a plain POSIX path is not something to prune')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('')
if (failed > 0) {
  console.error(`[picker-paths] ${failed} of ${checks.length} checks failed`)
  process.exitCode = 1
} else {
  console.log(`[picker-paths] all ${checks.length} checks passed`)
}
