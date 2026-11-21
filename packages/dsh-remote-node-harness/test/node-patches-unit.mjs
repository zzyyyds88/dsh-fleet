/**
 * Assert the patch chain's contract.
 *
 * The mechanism in `scripts/node-patches.mjs` is only worth anything if the ledger cannot rot:
 * a patch with no documented row is a change nobody can review, and a row with no patch is a
 * change that was quietly dropped. Both directions are checked here, plus the two ordering
 * rules that make replay deterministic.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyPatches, checkPatches, listPatches, readLedger } from '../scripts/node-patches.mjs'

const packageRoot = new URL('..', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, '')
const log = message => process.stdout.write(`[node-patches-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// ---- the shipped state -------------------------------------------------------
{
  // The chain is empty right now, and that is a claim worth asserting rather than assuming:
  // everything this project does to the node runtime at build 5 is a packaging step.
  const patches = listPatches(packageRoot)
  log(`patches on disk: ${String(patches.length)}`)
  const ledger = checkPatches(packageRoot)
  check(ledger.problems.length === 0, 'every patch has a complete ledger row and vice versa',
    ledger.problems.join('; '))
  for (const patch of patches) {
    check(/^\d{4}-[a-z0-9-]+$/u.test(`${String(patch.ordinal).padStart(4, '0')}-${patch.slug}`),
      `${patch.name} is NNNN-slug.patch`)
  }
}

// ---- the ordering rules ------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'node-patches-'))
  try {
    mkdirSync(join(root, 'patches', 'node'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'node-patches.zh.md'), [
      '# ledger',
      '',
      '| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |',
      '|---|---|---|---|---|---|',
      '| `0001-drop-a.patch` | pkg/a.ts | behaviour A | a node has no window | ran the suite | regenerate against the tag |',
      '| `0002-drop-b.patch` | pkg/b.ts | behaviour B | a node has no browser | ran the suite | regenerate against the tag |',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(root, 'patches', 'node', '0001-drop-a.patch'), 'diff\n', 'utf8')
    writeFileSync(join(root, 'patches', 'node', '0002-drop-b.patch'), 'diff\n', 'utf8')
    check(listPatches(root).map(p => p.ordinal).join(',') === '1,2',
      'patches are ordered by their ordinal, not by directory order')
    check(checkPatches(root).problems.length === 0, 'a complete ledger and its patches agree')

    // A patch with no row: the change nobody documented.
    writeFileSync(join(root, 'patches', 'node', '0003-drop-c.patch'), 'diff\n', 'utf8')
    const undocumented = checkPatches(root)
    check(undocumented.problems.some(p => p.includes('0003-drop-c.patch') && p.includes('no row')),
      'an undocumented patch is reported', undocumented.problems.join('; '))
    rmSync(join(root, 'patches', 'node', '0003-drop-c.patch'))

    // A row with no patch: the change that was silently dropped.
    writeFileSync(join(root, 'docs', 'node-patches.zh.md'), [
      '# ledger',
      '',
      '| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |',
      '|---|---|---|---|---|---|',
      '| `0001-drop-a.patch` | pkg/a.ts | behaviour A | a node has no window | ran the suite | regenerate against the tag |',
      '| `0002-drop-b.patch` | pkg/b.ts | behaviour B | a node has no browser | ran the suite | regenerate against the tag |',
      '| `0009-drop-gone.patch` | pkg/g.ts | behaviour G | a node has no GPU | ran the suite | regenerate against the tag |',
      '',
    ].join('\n'), 'utf8')
    const orphaned = checkPatches(root)
    check(orphaned.problems.some(p => p.includes('0009-drop-gone.patch') && p.includes('does not exist')),
      'a ledger row with no patch is reported', orphaned.problems.join('; '))

    // An empty field: a row that exists but says nothing.
    writeFileSync(join(root, 'docs', 'node-patches.zh.md'), [
      '# ledger',
      '',
      '| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |',
      '|---|---|---|---|---|---|',
      '| `0001-drop-a.patch` | pkg/a.ts | behaviour A |  | ran the suite | regenerate against the tag |',
      '| `0002-drop-b.patch` | pkg/b.ts | behaviour B | a node has no browser | ran the suite | regenerate against the tag |',
      '',
    ].join('\n'), 'utf8')
    const hollow = checkPatches(root)
    check(hollow.problems.some(p => p.includes('0001-drop-a.patch') && p.includes('"why" field is empty')),
      'a row with an empty reason is reported', hollow.problems.join('; '))

    // A duplicate ordinal: two patches that would apply in directory order, which is not an order.
    writeFileSync(join(root, 'docs', 'node-patches.zh.md'), 'nothing here\n', 'utf8')
    writeFileSync(join(root, 'patches', 'node', '0001-also-a.patch'), 'diff\n', 'utf8')
    let threw = ''
    try { listPatches(root) } catch (error) { threw = String(error.message) }
    check(threw.includes('share ordinal'), 'two patches with the same ordinal are refused', threw)

    // A name that carries no ordinal at all.
    rmSync(join(root, 'patches', 'node', '0001-also-a.patch'))
    writeFileSync(join(root, 'patches', 'node', 'fix-a.patch'), 'diff\n', 'utf8')
    threw = ''
    try { listPatches(root) } catch (error) { threw = String(error.message) }
    check(threw.includes('NNNN-slug.patch'), 'a patch name without an ordinal is refused', threw)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- the ledger is parsed, not trusted --------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'node-patches-'))
  try {
    mkdirSync(join(root, 'patches', 'node'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'node-patches.zh.md'), [
      'prose above the table',
      '',
      '| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |',
      '|---|---|---|---|---|---|',
      '| `0001-drop-a.patch` | pkg/a.ts | behaviour A | reason A | command A | plan A |',
      '',
      'prose below the table',
    ].join('\n'), 'utf8')
    writeFileSync(join(root, 'patches', 'node', '0001-drop-a.patch'), 'diff\n', 'utf8')
    const rows = readLedger(root)
    check(rows.size === 1, 'only table rows are read, not prose around them', String(rows.size))
    const row = rows.get('0001-drop-a.patch')
    check(row?.why === 'reason A' && row?.upstream === 'plan A',
      'each column keeps its own meaning', JSON.stringify(row))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- applying: the three states, and the alarm ---------------------------------
// The ledger rules above only police paperwork. What decides whether a node keeps its
// optimisation is `applyPatches`, so it is exercised against a real git repository rather than
// reasoned about: `applied` (the patch lands), `already` (a rebuilt tree still has it, which must
// not read as drift), and a genuine conflict (an upstream edit under the same lines), which must
// throw, name the patch, and leave no `.rej` behind.
{
  const root = mkdtempSync(join(tmpdir(), 'node-patches-apply-'))
  const repo = join(root, 'fork')
  const git = arguments_ => spawnSync('git', ['-C', repo, ...arguments_], { encoding: 'utf8' })
  const file = join(repo, 'behaviour.js')
  const original = 'line1\nline2\nline3\nline4\nline5\n'
  try {
    mkdirSync(join(root, 'patches', 'node'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(root, 'docs', 'node-patches.zh.md'), [
      '# ledger',
      '',
      '| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |',
      '|---|---|---|---|---|---|',
      '| `0001-drop-a.patch` | behaviour.js | behaviour A | a node has no window | ran the suite | regenerate against the tag |',
      '',
    ].join('\n'), 'utf8')
    check(git(['init', '-q']).status === 0, 'a scratch repository can be created to apply into')
    git(['config', 'user.email', 'test@example.invalid'])
    git(['config', 'user.name', 'test'])
    // Keep the bytes the patch was cut from: autocrlf would rewrite them on checkout and the
    // blob hashes in the diff would stop matching.
    git(['config', 'core.autocrlf', 'false'])
    writeFileSync(file, original, 'utf8')
    check(git(['add', 'behaviour.js']).status === 0 && git(['commit', '-qm', 'base']).status === 0,
      'the base commit is the state the patch was cut from')

    writeFileSync(file, original.replace('line2\n', 'line2-PATCHED\n'), 'utf8')
    const cut = git(['diff', '--', 'behaviour.js'])
    check(cut.status === 0 && cut.stdout.includes('+line2-PATCHED'),
      'a patch can be cut from a working tree', cut.stderr.trim())
    writeFileSync(join(root, 'patches', 'node', '0001-drop-a.patch'), cut.stdout, 'utf8')
    git(['checkout', '--', 'behaviour.js'])

    // dryRun: says what it would do, and does nothing.
    const preview = applyPatches(root, repo, { dryRun: true })
    check(preview.length === 1 && preview[0].state === 'would-apply',
      'a dry run reports would-apply', JSON.stringify(preview))
    check(readFileSync(file, 'utf8') === original, 'and changes nothing on disk')

    const first = applyPatches(root, repo)
    check(first.length === 1 && first[0].state === 'applied', 'a first apply lands the change',
      JSON.stringify(first))
    check(readFileSync(file, 'utf8').includes('line2-PATCHED'), 'the tree now carries it')

    // Rebuild after a rebuild: the change is present, so a forward apply fails — and that must
    // be `already`, not the drift alarm. This is the state every iteration on the trim rules
    // passes through.
    const second = applyPatches(root, repo)
    check(second.length === 1 && second[0].state === 'already',
      'a second run recognises the change as already present, not as drift', JSON.stringify(second))

    // Upstream rewrites the same line. The three-way merge cannot place the hunk, and the
    // failure must surface instead of being swallowed.
    writeFileSync(file, original.replace('line2\n', 'UPSTREAM-REWRITE\n'), 'utf8')
    git(['commit', '-qam', 'upstream moves the code underneath the patch'])
    let drift = ''
    try { applyPatches(root, repo) } catch (error) { drift = String(error.message) }
    check(drift.includes('0001-drop-a.patch') && drift.includes('drift alarm'),
      'an upstream edit under the same lines throws and names the patch', drift.split('\n')[0])
    check(drift.includes('do not use --reject'), 'and says what not to do about it')
    const strays = readdirSync(repo).filter(name => name.endsWith('.rej') || name.endsWith('.orig'))
    check(strays.length === 0, 'no .rej or .orig is left in the tree that gets packed',
      strays.join(', ') || 'none')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- a hunk upstream only *moved* still applies ------------------------------
// This is the case that keeps upstream's own fixes flowing: a release that inserts lines above our
// hunk changes its offsets but not its content. A plain apply refuses it; `--3way` relocates it.
// Getting this wrong in the other direction (throwing on every offset change) would make every
// upstream release look like a conflict and tempt somebody to delete the patch.
{
  const root = mkdtempSync(join(tmpdir(), 'node-patches-move-'))
  const repo = join(root, 'fork')
  const git = arguments_ => spawnSync('git', ['-C', repo, ...arguments_], { encoding: 'utf8' })
  const file = join(repo, 'behaviour.js')
  const original = 'line1\nline2\nline3\nline4\nline5\n'
  try {
    mkdirSync(join(root, 'patches', 'node'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(root, 'docs', 'node-patches.zh.md'), [
      '# ledger',
      '',
      '| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |',
      '|---|---|---|---|---|---|',
      '| `0001-drop-a.patch` | behaviour.js | behaviour A | a node has no window | ran the suite | regenerate against the tag |',
      '',
    ].join('\n'), 'utf8')
    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.invalid'])
    git(['config', 'user.name', 'test'])
    git(['config', 'core.autocrlf', 'false'])
    writeFileSync(file, original, 'utf8')
    git(['add', 'behaviour.js'])
    git(['commit', '-qm', 'base'])
    writeFileSync(file, original.replace('line2\n', 'line2-PATCHED\n'), 'utf8')
    writeFileSync(join(root, 'patches', 'node', '0001-drop-a.patch'),
      git(['diff', '--', 'behaviour.js']).stdout, 'utf8')
    git(['checkout', '--', 'behaviour.js'])

    // Upstream prepends two lines: the hunk's offsets move by two, its content does not.
    writeFileSync(file, `inserted-a\ninserted-b\n${original}`, 'utf8')
    git(['commit', '-qam', 'upstream inserts lines above the patched hunk'])
    const moved = applyPatches(root, repo)
    check(moved.length === 1 && moved[0].state === 'applied',
      'a hunk upstream merely shifted is relocated, not reported as drift', JSON.stringify(moved))
    const after = readFileSync(file, 'utf8')
    check(after.startsWith('inserted-a\ninserted-b\n') && after.includes('line2-PATCHED'),
      'and it lands in the shifted position, leaving the inserted lines alone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  log(`${String(failures.length)} failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all assertions passed')
}
