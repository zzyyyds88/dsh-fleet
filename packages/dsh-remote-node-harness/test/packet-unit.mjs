/**
 * Regression guard for the SSH packet ceiling.
 *
 * Measured on a real node (OpenSSH `PACKET_MAX_SIZE` = 256 KiB), with a single
 * `ssh2` connection and the node's own `auth.log` counters:
 *
 *   exec command line  240,000 bytes → +0 connections, +0 corrupted
 *   exec command line  262,000 bytes → +0 connections, +0 corrupted
 *   exec command line  262,200 bytes → +6 connections, +6 corrupted
 *   exec command line  300,000 bytes → +6 connections, +6 corrupted
 *   same payload on stdin, 300 KB / 7.9 MB → +0 connections, +0 corrupted
 *
 * `Bad packet length 7923616.` in that log is the number sshd read where it expected a
 * 4-byte packet header, and 7,923,616 is the size of `writePluginBundle`'s `exec` command
 * for `dsh-whale-widget` (7,923,386 bytes) to within the script's tail. ssh2 writes an
 * `exec` request as ONE packet however long the command is
 * (`Protocol.js:1273 alloc(1 + 4 + 4 + 4 + 1 + 4 + cmdLen)`), so the whole command line
 * is one SSH packet and anything over the server's ceiling breaks the connection.
 *
 * This test pins the rule that keeps it from coming back: **no payload travels on a
 * command line**. It reads the two writers that ship trees and asserts the tree goes to
 * `stdin`, and it asserts the connection layer refuses an oversized command outright
 * instead of sending one.
 *
 * Usage: node test/packet-unit.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SshConnection } from '../src/ssh/connection.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
const check = (ok, label, detail) => {
  if (!ok) {
    failures += 1
    process.stderr.write(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
  } else {
    process.stdout.write(`ok   ${label}\n`)
  }
}

// ---- the rule itself ---------------------------------------------------------
// OpenSSH's `PACKET_MAX_SIZE`. A command line is allowed to approach it but must never
// cross it, and the connection layer must say so locally rather than discover it on the
// server (where the cost is a corrupted stream, not an error message).
const { MAX_COMMAND_BYTES } = await import('../src/ssh/connection.js')
check(typeof MAX_COMMAND_BYTES === 'number' && MAX_COMMAND_BYTES > 0,
  'the connection layer names its command-line ceiling', String(MAX_COMMAND_BYTES))
check(MAX_COMMAND_BYTES <= 256 * 1024,
  'and it sits at or under OpenSSH PACKET_MAX_SIZE (256 KiB)', String(MAX_COMMAND_BYTES))

// ---- no writer puts a tree on a command line ---------------------------------
for (const [file, name, marker] of [
  ['src/remote/daemon.js', 'writeBrainBundle', 'RNH_BRAIN_FILES_EOF'],
  ['src/remote/daemon.js', 'writePluginBundle', 'RNH_PLUGIN_FILES_EOF'],
]) {
  const source = readFileSync(join(root, file), 'utf8')
  const at = source.indexOf(`async ${name}(`)
  check(at > 0, `${name} exists in ${file}`)
  if (at < 0) continue
  const end = source.indexOf('\n  }', at)
  const body = source.slice(at, end === -1 ? undefined : end)
  // The script itself is short and belongs on `argv`; the *tree* is what must not.
  check(/stdin:/u.test(body),
    `${name} ships the tree on stdin, which is split into channel-data packets`)
  check(!body.includes(marker),
    `${name} has no heredoc carrying the tree into the command line`)
  // Whatever the script is, it has to fit comfortably under the ceiling.
  const literals = [...body.matchAll(/`([^`]*)`/gu)].map(match => match[1])
  const largest = Math.max(0, ...literals.map(text => Buffer.byteLength(text)))
  check(largest < MAX_COMMAND_BYTES / 4,
    `${name}'s script stays far under the ceiling`, `${String(largest)} bytes`)
}

// ---- and the guard is real ---------------------------------------------------
// A stub client that records what it was asked to send: the oversized command must be
// rejected before a channel is ever opened.
{
  const connection = new SshConnection({
    host: '127.0.0.1', port: 22, username: 'nobody',
    auth: { kind: 'password', password: 'x' }, label: 'packet-unit',
  })
  let opened = 0
  connection.client = async () => ({ exec: () => { opened += 1 } })
  const oversized = 'A'.repeat(MAX_COMMAND_BYTES + 1)
  let error
  try {
    await connection.exec({ argv: ['sh', '-c', oversized] })
  } catch (caught) {
    error = caught
  }
  check(error !== undefined, 'an oversized command line is refused')
  check(opened === 0, 'and no channel is opened to find that out', `opened=${String(opened)}`)
  check(/too long|packet|command line/iu.test(String(error?.message)),
    'the refusal says what is wrong', String(error?.message).slice(0, 120))
  connection.dispose()
}

// The same command one byte under the ceiling is *not* refused locally. It fails at the
// stub, which is what proves the boundary is the size and not something else.
{
  const connection = new SshConnection({
    host: '127.0.0.1', port: 22, username: 'nobody',
    auth: { kind: 'password', password: 'x' }, label: 'packet-unit',
  })
  let opened = 0
  connection.client = async () => ({
    exec: (_command, callback) => {
      opened += 1
      callback(new Error('stub refuses'))
    },
  })
  try {
    await connection.exec({ argv: ['sh', '-c', 'A'.repeat(MAX_COMMAND_BYTES - 32)] })
  } catch { /* the stub's refusal is the expected end of this path */ }
  check(opened > 0, 'a command under the ceiling still reaches the client', `opened=${String(opened)}`)
  connection.dispose()
}

process.stderr.write(failures === 0 ? 'all checks passed\n' : `${String(failures)} failed\n`)
process.exit(failures === 0 ? 0 : 1)
