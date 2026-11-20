/**
 * Assert the patch chain's contract.
 *
 * The mechanism in `scripts/node-patches.mjs` is only worth anything if the ledger cannot rot:
 * a patch with no documented row is a change nobody can review, and a row with no patch is a
 * change that was quietly dropped. Both directions are checked here, plus the two ordering
 * rules that make replay deterministic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPatches, listPatches, readLedger } from '../scripts/node-patches.mjs'

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

if (failures.length > 0) {
  log(`${String(failures.length)} failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all assertions passed')
}
