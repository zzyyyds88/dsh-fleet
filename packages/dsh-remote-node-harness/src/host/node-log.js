/**
 * One node's recent connection log, as a person reads it when something is wrong.
 *
 * The Host already logs every lifecycle step through `ctx.logger`, but that goes to the
 * desktop's own log — which is fine for the maintainer and useless for the person looking at a
 * red card: they are not going to find a log file, and if they do it is interleaved with every
 * other node and every other plugin.
 *
 * So each node keeps its own last hundred lines, in memory, and the card can show them. Three
 * decisions that matter:
 *
 * - **Redaction happens on write, not on read.** A secret that reaches the buffer has already
 *   leaked into whatever reads it next (a copied log, a screenshot, a bug report). The patterns
 *   below are applied to every line before it is stored.
 * - **It is bounded and in memory.** A node that has been connected for a week must not turn
 *   into a growing file; a hundred lines covers "what happened during the last connect".
 * - **Timestamps are kept.** "It worked five minutes ago and stopped" is most of the diagnosis,
 *   and it is not recoverable from the message text.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/node-log
 */

/** How many lines one node keeps. */
export const LOG_LINES = 100

/**
 * Patterns whose match is replaced before a line is stored.
 *
 * Deliberately broad: a false positive costs one unreadable word in a log, a false negative
 * costs a leaked password in a bug report. Every pattern replaces the **value**, keeping the
 * key, so `password=hunter2` becomes `password=***` and stays readable.
 */
const REDACTIONS = Object.freeze([
  // A bare bearer token or a `ssh2` key blob. **Before** the `key=value` rule below, which
  // would otherwise match `Authorization: Bearer` and leave the token itself behind — measured
  // on `Authorization: Bearer abc.def`, which came out as `Authorization=*** abc.def`.
  [/\bBearer\s+\S+/gu, 'Bearer ***'],
  // `password=hunter2`, `token: abc`, `"privateKey":"-----BEGIN…"`
  [/\b(password|passphrase|secret|token|authorization|api[-_]?key)\s*[=:]\s*\S+/giu, '$1=***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '***PRIVATE KEY***'],
  // An `ssh://user:password@host` or `https://user:token@host` URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1***@'],
])

/**
 * Remove anything that looks like a secret.
 *
 * Exported because the same rule has to hold wherever a log line is produced, not only here.
 * @param {string} line
 * @returns {string}
 */
export function redact(line) {
  let text = String(line)
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  return text
}

/** A bounded, redacting, in-memory log for one node. */
export class NodeLog {
  /** @type {Array<{ at: number, level: 'info' | 'warn' | 'error', text: string }>} */
  #lines = []

  /**
   * Append one line.
   * @param {string} text
   * @param {'info' | 'warn' | 'error'} [level]
   */
  push(text, level = 'info') {
    const trimmed = redact(text).trim()
    if (trimmed === '') return
    this.#lines.push({ at: Date.now(), level, text: trimmed.slice(0, 2000) })
    // One over the limit is trimmed at once rather than in batches: a hundred lines is small
    // enough that the copy is cheaper than the bookkeeping a ring index would need.
    if (this.#lines.length > LOG_LINES) this.#lines = this.#lines.slice(-LOG_LINES)
  }

  /** The lines, oldest first, as the surface renders them. */
  lines() {
    return this.#lines.map(line => ({ ...line }))
  }

  /** Everything, formatted as the text a person copies into a bug report. */
  text() {
    return this.#lines
      .map(line => `${new Date(line.at).toISOString()} ${line.level.toUpperCase()} ${line.text}`)
      .join('\n')
  }

  /** Drop everything, on a deliberate disconnect. */
  clear() {
    this.#lines = []
  }
}
