/**
 * Browsing a directory tree — locally, and on a node.
 *
 * The workspace picker needs to answer one question: "which folders can I make a
 * workspace from?" On this machine that is the Host's own filesystem; on a node it is
 * the node's, reached over the SSH connection this plugin already holds.
 *
 * Two implementations, not one with a branch: a local `readdir` and a remote `find` have
 * nothing in common but their answer, and pretending otherwise is how a path separator
 * or a permission error ends up handled wrongly on one of the two sides.
 *
 * @module @local/dsh-fleet/host/browse
 */
import { readdir, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** How many folders one listing returns; a directory with more is still usable. */
const MAX_ENTRIES = 500

/**
 * Normalise a path the user typed or a parent link produced.
 *
 * An empty path means "start where the user lives", which is the only useful default:
 * both the local home and a node's home are where their projects are.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizeLocal(path) {
  const trimmed = typeof path === 'string' ? path.trim() : ''
  if (trimmed.length === 0) return homedir()
  return resolve(trimmed)
}

/**
 * The parent of a path, or `undefined` at a root.
 *
 * `dirname('D:\\')` returns `'D:\\'`, so comparing is the only way to know the walk is
 * over — otherwise the UI offers a "go up" that goes nowhere.
 * @param {string} path
 * @returns {string | undefined}
 */
export function parentOfLocal(path) {
  const parent = dirname(path)
  return parent === path ? undefined : parent
}

/**
 * List the folders in one local directory.
 *
 * Files are filtered out rather than marked: a workspace is a directory, so showing files
 * would only add rows nobody can pick.
 *
 * @param {string} [path]
 * @returns {Promise<{ path: string, home: string, parent?: string, entries: Array<{ name: string, path: string }>, truncated: boolean }>}
 */
export async function listLocal(path) {
  const wanted = normalizeLocal(path)
  // Resolve symlinks so "up" behaves: a link into another tree would otherwise walk back
  // through the link and look like it went nowhere.
  let target = wanted
  try {
    target = await realpath(wanted)
  } catch {
    // A path that does not resolve is reported by the `stat` below, with its message.
  }
  const info = await stat(target)
  if (!info.isDirectory()) {
    throw Object.assign(new Error(`${target} is not a directory`), { code: 'not-a-directory' })
  }
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = []
  let truncated = false
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    // A hidden directory is not offered, but it is still reachable by typing its path:
    // `.git` and `.cache` are noise in a picker, and a project never lives in one.
    if (dirent.name.startsWith('.')) continue
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    if (entries.length >= MAX_ENTRIES) { truncated = true; break }
    entries.push({ name: dirent.name, path: join(target, dirent.name) })
  }
  const parent = parentOfLocal(target)
  return {
    path: target,
    home: homedir(),
    ...(parent === undefined ? {} : { parent }),
    entries,
    truncated,
  }
}

/**
 * List the folders on a node.
 *
 * Runs through the SSH connection this plugin already has, not through the node's Harness:
 * browsing a directory is a filesystem question, and asking a running Host would mean the
 * node had to be up before its own folders could be chosen. It also keeps a permission
 * error reported as one, instead of surfacing as a missing RPC endpoint.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {string} [path] - absolute POSIX path; empty means the node's home directory.
 * @returns {Promise<{ path: string, home: string, parent?: string, entries: Array<{ name: string, path: string }>, truncated: boolean }>}
 */
export async function listRemote(connection, path) {
  const wanted = typeof path === 'string' && path.trim().length > 0 ? path.trim() : ''
  // One shell invocation answers all three facts: the resolved absolute path (a bare `~`
  // or a relative argument has to become absolute before it can be a workspace), the
  // home directory, and the folder list. `$1` is passed as an argument, not interpolated,
  // so a path with spaces or quotes cannot become part of the script.
  const script = `
set -u
target=\${1:-}
if [ -z "$target" ]; then target="$HOME"; fi
if ! cd "$target" 2>/dev/null; then
  printf 'FLEET_BROWSE_ERROR=%s\\n' "$(cd "$target" 2>&1 | tail -1)"
  exit 0
fi
printf 'FLEET_BROWSE_PATH=%s\\n' "$(pwd -P)"
printf 'FLEET_BROWSE_HOME=%s\\n' "$HOME"
find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print 2>/dev/null | LC_ALL=C sort | head -n ${String(MAX_ENTRIES + 1)}
`.trim()
  const result = await connection.exec({
    argv: ['sh', '-c', script, 'sh', wanted],
    timeoutMs: 30_000,
    maxBytes: 512 * 1024,
  })
  const output = `${result.stdout}\n${result.stderr}`
  const failure = /FLEET_BROWSE_ERROR=(.*)/u.exec(output)
  if (failure !== null) {
    throw Object.assign(new Error(`${wanted === '' ? '~' : wanted}: ${failure[1].trim()}`), {
      code: 'browse-failed',
    })
  }
  const resolved = /FLEET_BROWSE_PATH=(.*)/u.exec(output)?.[1]?.trim()
  const home = /FLEET_BROWSE_HOME=(.*)/u.exec(output)?.[1]?.trim() ?? '/'
  if (resolved === undefined) {
    throw Object.assign(new Error(`reading ${wanted === '' ? '~' : wanted} failed: ${output.trim().slice(-300)}`), {
      code: 'browse-failed',
    })
  }
  const names = []
  for (const line of output.split('\n')) {
    const match = /^\.\/(.+)$/u.exec(line.trim())
    if (match !== null) names.push(match[1])
  }
  const truncated = names.length > MAX_ENTRIES
  const entries = names.slice(0, MAX_ENTRIES).map(name => ({
    name,
    // POSIX joining, on purpose: this path belongs to the node, not to this machine.
    path: `${resolved.replace(/\/+$/u, '')}/${name}`,
  }))
  const parent = resolved === '/' ? undefined : resolved.replace(/\/[^/]+$/u, '') || '/'
  return {
    path: resolved,
    home,
    ...(parent === undefined ? {} : { parent }),
    entries,
    truncated,
  }
}

/**
 * Whether a string is an absolute POSIX path a node could own.
 *
 * Deliberately not `path.isAbsolute`: on Windows that answers true for `/foo` as well,
 * so it cannot tell "a path on the node" from "a path on this machine".
 * @param {unknown} path
 * @returns {boolean}
 */
export function isPosixAbsolute(path) {
  return typeof path === 'string' && path.startsWith('/')
}
