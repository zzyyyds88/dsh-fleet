/**
 * Version arithmetic for the host/node pair, and the decision it drives.
 *
 * A node is a **separate DSH installation** with its own release, its own profile
 * and its own copy of the brain bundle. The desktop plugin and that node can drift
 * apart in two independent ways:
 *
 * | drift | what breaks |
 * |---|---|
 * | DSH runtime versions differ | the Session log format, the Remote descriptor set, the Gateway wire — everything |
 * | brain bundle builds differ | the node composes rows the installed DSH does not have, or misses ones it does |
 *
 * So there are **two** versions to compare, and they are compared to different
 * standards:
 *
 * - the runtime must be **exactly equal** (a node one minor ahead is not "probably
 *   fine" — its descriptor set is what the routing decorators dispatch into);
 * - the brain build may be **equal or older** on the node, because a newer host is
 *   the normal case right after an upgrade. A node *newer* than the host is refused:
 *   that means somebody pointed an old desktop at a machine another (newer) desktop
 *   already provisioned, and the local side cannot know what rows it wrote.
 *
 * @module @zzyyyds88/dsh-fleet/core/version
 */

/** One parsed version, with the pre-release fields kept for ordering. */
const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u

/**
 * Parse a version string like `0.2.2-rc.3` or `v22.20.0`.
 * @param {unknown} value
 * @returns {{ major: number, minor: number, patch: number, pre: string[], text: string } | undefined}
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = PATTERN.exec(value.trim())
  if (match === null) return undefined
  const pre = match[4] === undefined ? [] : match[4].split('.')
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre,
    text: value.trim(),
  }
}

/**
 * Compare two parsed versions with semver precedence.
 *
 * A pre-release sorts **before** its release (`0.2.2-rc.3 < 0.2.2`), and pre-release
 * identifiers compare numerically when both are numeric, lexically otherwise — the
 * same rule npm uses, which matters because DSH releases candidates.
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const numeric = /^\d+$/u
    if (numeric.test(a) && numeric.test(b)) return Number(a) < Number(b) ? -1 : 1
    if (numeric.test(a)) return -1
    if (numeric.test(b)) return 1
    return a < b ? -1 : 1
  }
  return 0
}

/** What the host does about one node, given what is installed there. */
export const GATE = Object.freeze({
  /** Nothing to do: both versions match. */
  CURRENT: 'current',
  /** The DSH runtime is missing or differs: install it. */
  INSTALL: 'install',
  /** The runtime matches but the brain build is older: refresh the bundle. */
  REFRESH: 'refresh',
  /** The node is ahead of this host. Refused rather than guessed at. */
  AHEAD: 'ahead',
  /** The node's answer is unreadable, so it must be treated as unknown. */
  UNKNOWN: 'unknown',
})

/**
 * Decide what to do for one node.
 *
 * @param {object} input
 * @param {string} input.hostVersion - the DSH release this desktop runs.
 * @param {string} input.hostBrain - this plugin's own version (what it would install).
 * @param {string | undefined} input.nodeVersion - the release installed on the node, if any.
 * @param {string | undefined} input.nodeBrain - the brain build found on the node, if any.
 * @param {string | undefined} [input.nodeRuntime] - why the installed tree is not usable
 *   as-is, when it is on the right version but was packed differently.
 * @returns {{ action: string, reason: string, message: string }}
 */
export function decideGate(input) {
  const host = parseVersion(input.hostVersion)
  const node = parseVersion(input.nodeVersion)
  const hostBrain = parseVersion(input.hostBrain)
  const nodeBrain = parseVersion(input.nodeBrain)

  if (host === undefined) {
    return {
      action: GATE.UNKNOWN,
      reason: 'host-version-unreadable',
      message: `this desktop did not report a readable DSH version (${String(input.hostVersion)})`,
    }
  }
  // No runtime at all is the ordinary first-connect case, not an error.
  if (node === undefined) {
    return {
      action: GATE.INSTALL,
      reason: 'node-runtime-missing',
      message: `installing DSH ${host.text} on this node`,
    }
  }
  if (compareVersions(node, host) === 0) {
    // Same release, but packed differently from what this plugin would install. The
    // version says *which release* the tree is; it says nothing about who packed it, and
    // a changed strip rule produces a tree this build cannot run at the same version.
    if (typeof input.nodeRuntime === 'string' && input.nodeRuntime.length > 0) {
      return {
        action: GATE.INSTALL,
        reason: 'node-runtime-repack',
        message: `reinstalling this node's DSH: ${input.nodeRuntime}`,
      }
    }
    // The runtime matches. A missing brain build is the same as an old one.
    if (nodeBrain === undefined) {
      return {
        action: GATE.REFRESH,
        reason: 'node-brain-missing',
        message: `installing brain build ${hostBrain?.text ?? 'unknown'} on this node`,
      }
    }
    const order = hostBrain === undefined ? 0 : compareVersions(nodeBrain, hostBrain)
    if (order === 0) {
      return { action: GATE.CURRENT, reason: 'in-step', message: 'node is in step with this desktop' }
    }
    if (order < 0) {
      return {
        action: GATE.REFRESH,
        reason: 'node-brain-behind',
        message: `upgrading this node's brain: ${nodeBrain.text} → ${hostBrain.text}`,
      }
    }
    return {
      action: GATE.AHEAD,
      reason: 'node-brain-ahead',
      message: `this node runs brain build ${nodeBrain.text}, which is newer than this desktop's `
        + `${hostBrain.text}. Another (newer) desktop provisioned it. Upgrade this desktop, or `
        + 'remove that profile on the node, before connecting — the rows it wrote cannot be '
        + 'predicted from here.',
    }
  }
  if (compareVersions(node, host) > 0) {
    return {
      action: GATE.AHEAD,
      reason: 'node-runtime-ahead',
      message: `this node runs DSH ${node.text}, which is newer than this desktop's ${host.text}. `
        + 'Its Remote descriptor set may not match what this plugin dispatches into, so the '
        + 'connection is refused instead of half-working. Upgrade the desktop app.',
    }
  }
  return {
    action: GATE.INSTALL,
    reason: 'node-runtime-behind',
    message: `upgrading this node's DSH: ${node.text} → ${host.text}`,
  }
}

/**
 * Whether a decision means "this node must change before it is usable".
 * @param {string} action
 */
export function requiresProvisioning(action) {
  return action === GATE.INSTALL || action === GATE.REFRESH
}
