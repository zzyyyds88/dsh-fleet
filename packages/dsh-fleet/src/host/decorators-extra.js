/**
 * The remaining identity-carrying Remote namespaces: `goals`, `userQuestions`, `subagents`,
 * `commands`, `messageFeedback`, `sessionReferenceResolver`, `fileReferences`, `schedule`.
 *
 * Each of these either names a Session (in a `request` field or as an `agent: Agent`
 * parameter) or is Host-wide but returns rows that belong to one machine. Left unrouted they
 * do not fail loudly — they answer **from this Host**, which for a remote Session is a
 * confidently wrong answer:
 *
 *   - `goal/get` on a remote Session returns `undefined`, so the goal bar disappears;
 *   - `commands/list` lists this desktop's slash commands, not the node's;
 *   - `fileReferences/list` autocompletes paths on this machine's disk;
 *   - `messageFeedback/*` reads and writes feedback for a Session this Host does not have;
 *   - `subagents/prompt` cannot reach a child that lives on the node;
 *   - `schedule/list` shows only this Host's tasks while the tasks created for remote
 *     Sessions live on the node.
 *
 * The shapes are not uniform, which is why each group has its own factory — the file is long
 * because the surface is, not because it does one thing twice.
 *
 * @module @greatbaby/dsh-fleet/host/decorators-extra
 */
import { decodeRemoteId, decorateMethods, encodeRemoteId, remoteIterable } from './routing.js'

/** Read one field without trusting the object's shape. */
function fieldOf(value, name) {
  if (value === null || typeof value !== 'object') return undefined
  return Reflect.get(value, name)
}

/** The request object one endpoint receives, whether wrapped or bare. */
function requestIn(value) {
  if (value === null || typeof value !== 'object') return undefined
  const request = Reflect.get(value, 'request')
  return request !== null && typeof request === 'object' ? request : value
}

/**
 * Install the `goals` router.
 *
 * Every endpoint takes `agent: Agent` first, which `host/lookups.js` already resolves for a
 * wrapped Session identity. What is left is rewriting `agentId` to the node's own Session id
 * and wrapping the returned `GoalView`.
 *
 * `get` is the one that matters most in practice: a remote Session's goal lives on the node,
 * so answering locally hides the goal bar and makes `goal_*` look broken.
 *
 * @param {object} service - the live upstream `goals` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateGoals(service, router) {
  return decorateMethods(service, {
    get: local => router.agentEndpoint('goals/get', [], local),
    create: local => router.agentEndpoint('goals/create', ['request'], local),
    edit: local => router.agentEndpoint('goals/edit', ['ref', 'request'], local),
    pause: local => router.agentEndpoint('goals/pause', ['ref'], local),
    resume: local => router.agentEndpoint('goals/resume', ['ref'], local),
    complete: local => router.agentEndpoint('goals/complete', ['ref'], local),
    clear: local => router.agentEndpoint('goals/clear', ['ref'], local),
  })
}

/**
 * Install the `userQuestions` router.
 *
 * The browser answers a question card by calling `answer(agent, callId, answer)`; for a
 * remote Session the question was raised by the node's tool run, so the bool it returns is
 * the node's own. `attachWait` is a stream and has to be proxied rather than awaited, or the
 * card's countdown never starts.
 *
 * @param {object} service - the live upstream `userQuestions` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateUserQuestions(service, router) {
  return decorateMethods(service, {
    answer: local => router.agentEndpoint('userQuestions/answer', ['callId'], local, { wrapResult: false }),

    // The stream's first positional argument is the `Agent`, not a request object, so the
    // generic session-stream proxy cannot be used.
    attachWait: local => function attachWait(agent, callId, signal) {
      const decoded = decodeRemoteId(agent?.id)
      if (decoded === undefined) return local(agent, callId, signal)
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'userQuestions/attachWait',
        { agentId: decoded.remoteId, callId },
        signal,
      )
    },
  })
}

/**
 * Install the `subagents` router.
 *
 * A subagent's own Session id is a bare uuid, and the wrapping rule in `routing.js` packs a
 * bare uuid only when the field name says it is a Session — so `request.childSessionId` is
 * the identity to route on, both when delivering a message and when interrupting.
 *
 * @param {object} service - the live upstream `subagents` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateSubagents(service, router) {
  return decorateMethods(service, {
    prompt: local => router.fieldEndpoint('subagents/prompt', 'childSessionId', local),
    interruptByUser: local => router.firstArgEndpoint('subagents/interruptByUser', 'childSessionId', local),
  })
}

/**
 * Install the `commands` router.
 *
 * A slash command is not a client-side string: `commands/list` returns the descriptors the
 * **node's** composition provides, and `execute` runs on the node against the node's
 * `Agent`. Answering locally shows commands that do not exist there and then fails when one
 * is used.
 *
 * @param {object} service - the live upstream `commands` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateCommands(service, router) {
  return decorateMethods(service, {
    list: local => router.agentEndpoint('commands/list', [], local, { wrapResult: false }),
    // `execute(agent, line, submittedAttachments, signal)` — the attachments array is the
    // second positional argument and the signal is forwarded out of band.
    execute: local => router.agentEndpoint('commands/execute', ['line', 'submittedAttachments'], local),
  })
}

/**
 * Install the `messageFeedback` router.
 *
 * Feedback is attached to one assistant message of one Session, so all three verbs name the
 * Session in their request. Unrouted, a thumbs-down on a remote answer either fails with
 * "session not found" or — worse — lands on a different local Session with the same id shape.
 *
 * @param {object} service - the live upstream `messageFeedback` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateMessageFeedback(service, router) {
  return decorateMethods(service, {
    list: local => router.fieldEndpoint('messageFeedback/list', 'sessionId', local),
    put: local => router.fieldEndpoint('messageFeedback/put', 'sessionId', local),
    delete: local => router.fieldEndpoint('messageFeedback/delete', 'sessionId', local),
  })
}

/**
 * Install the `sessionReferenceResolver` router.
 *
 * `@`-mentions of a Session resolve against the Sessions the agent can see; for a remote
 * Session that list is the node's. Answering locally offers references the node cannot open.
 *
 * @param {object} service - the live upstream `sessionReferenceResolver` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateSessionReferenceResolver(service, router) {
  return decorateMethods(service, {
    candidates: local => router.agentEndpoint('sessionReferenceResolver/candidates', ['query'], local),
  })
}

/**
 * Install the `fileReferences` router.
 *
 * The `@`-mention path autocomplete is the one surface where a wrong answer is immediately
 * visible: a remote Session would offer this Windows machine's files. The provider is asked
 * with the Agent's own working directory, so the node must answer.
 *
 * @param {object} service - the live upstream `sessionFileReferences` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateFileReferences(service, router) {
  return decorateMethods(service, {
    list: local => router.agentEndpoint('fileReferences/list', ['query'], local, { wrapResult: false }),
  })
}

/**
 * Install the `agentPresets` router.
 *
 * The preset seat in the composer is not decoration: choosing a mode **recomposes
 * the Agent**, which for a remote Session has to happen on the node. Left unrouted,
 * `agentPresets/select` runs here against a placeholder Agent whose `session` is
 * deliberately `undefined` (see `host/lookups.js`), and the upstream implementation
 * dies on its first line:
 *
 *   `this.owner.agents.turnBoundaryOf(agent.session)` → `.header` of undefined
 *
 * Measured in the desktop app: switching a remote Session's mode answered
 * `无法切换到「node-control」：Cannot read properties of undefined (reading
 * 'header')`, which names neither the cause nor the fix.
 *
 * Routing it makes the node's own registry answer, so a preset the node really has
 * is applied there, and one it does not have comes back as the node's named
 * `agent-preset/not-found` with its available list. That is the honest answer:
 * a remote Session's brain runs on the node, so a Host-only preset (such as
 * `node-control`, which manages *this* machine's recorded nodes) cannot compose it.
 *
 * `list` and `read` stay local on purpose. They describe the roster a **new**
 * Session can be created from here, and a merged roster would advertise presets
 * that cannot be selected for the Session in front of the person.
 *
 * @param {object} service - the live upstream `agentPresets` service.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateAgentPresets(service, router) {
  return decorateMethods(service, {
    // `select(agent, agentPreset)` — the Agent is the first positional argument,
    // resolved from `agentId` before the method runs, so `agentEndpoint` has
    // everything it needs from `host/lookups.js`.
    select: local => router.agentEndpoint('agentPresets/select', ['agentPreset'], local, { wrapResult: false }),
  })
}

/**
 * Install the `schedule` router: merge the Host-wide list, route the per-entry verbs.
 *
 * This namespace is different from the others in one respect that decides the design: its
 * entries are **Host-wide**, not Session-scoped, so there is no request field to key on for
 * `list`/`catalog`. The only way the browser can name one entry across every machine is a
 * wrapped identity, so:
 *
 *   - `catalog` / `list` / `history` are **merged**: this Host's rows plus every routable
 *     node's, with each node row's `id` wrapped;
 *   - `view` / `edit` / `run` decode that id back and forward;
 *   - `create` names its destination in `request.target`, whose `sessionId` is wrapped — the
 *     node needs its own id there;
 *   - `deleteInactive` is Host-wide bookkeeping with no identity, so it runs here and on every
 *     routable node: leaving the node's inactive entries behind means the next merge shows
 *     tasks that "cannot be deleted".
 *   - `deliveryLimits` describes this Host's own configuration and stays local.
 *
 * A node that cannot answer is skipped rather than failing the whole list: an offline machine
 * must not empty the schedule page.
 *
 * @param {object} service - the live upstream `schedule` service.
 * @param {import('./router.js').Router} router
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {() => void}
 */
export function decorateSchedule(service, router, options = {}) {
  const log = options.log ?? (() => {})

  /** Add one node's rows to this Host's, wrapping each identity. */
  const merge = async (local, call) => {
    const own = await local()
    const rows = Array.isArray(own) ? own : (fieldOf(own, 'items') ?? [])
    const merged = Array.isArray(rows) ? [...rows] : []
    for (const runtime of router.nodes()) {
      const nodeId = runtime.record.id
      try {
        const remote = await call(nodeId)
        const remoteRows = Array.isArray(remote) ? remote : (fieldOf(remote, 'items') ?? [])
        for (const row of Array.isArray(remoteRows) ? remoteRows : []) {
          const id = fieldOf(row, 'id')
          merged.push(typeof id === 'string' ? { ...row, id: encodeRemoteId(nodeId, id) } : row)
        }
      } catch (error) {
        // An offline node contributes nothing; that is the same answer as "it has no tasks",
        // and failing here would make the whole page depend on every machine being up.
        log(`fleet: schedule from ${runtime.record.name} unavailable: ${error?.message ?? String(error)}`)
      }
    }
    // The local shape is returned as-is when it was an envelope, so the browser reads one
    // schema whether or not a node answered.
    if (Array.isArray(own)) return merged
    return { ...own, items: merged }
  }

  /** Route one per-entry verb. */
  const entry = (endpoint, local) => async function routed(request, signal) {
    const id = fieldOf(requestIn(request), 'id') ?? fieldOf(requestIn(request), 'scheduleId')
    const decoded = decodeRemoteId(typeof id === 'string' ? id : undefined)
    if (decoded === undefined) return await local(request, signal)
    const payload = router.toRemote({ request: { ...requestIn(request), id: decoded.remoteId } }, decoded.nodeId)
    return router.toLocal(await router.call(decoded.nodeId, endpoint, payload, signal), decoded.nodeId)
  }

  return decorateMethods(service, {
    catalog: local => async function catalog(...args) {
      const merged = await merge(() => local(...args), nodeId => router.call(nodeId, 'schedule/catalog', {}))
      return merged
    },

    list: local => async function list(request, signal) {
      // Paging is this Host's answer over the merged rows: asking each node with the same
      // offset would return overlapping pages.
      const merged = await merge(
        () => local(request, signal),
        nodeId => router.call(nodeId, 'schedule/list', { request: { ...requestIn(request), limit: undefined, offset: undefined } }, signal),
      )
      const items = Array.isArray(merged) ? merged : (fieldOf(merged, 'items') ?? [])
      const limit = fieldOf(requestIn(request), 'limit')
      const offset = fieldOf(requestIn(request), 'offset')
      if (!Array.isArray(items) || (limit === undefined && offset === undefined)) return merged
      const from = typeof offset === 'number' ? offset : 0
      const page = items.slice(from, typeof limit === 'number' ? from + limit : undefined)
      return { ...(Array.isArray(merged) ? {} : merged), items: page }
    },

    history: local => async function history(request, signal) {
      // Delivery history is per entry, so this is a per-entry route rather than a merge.
      const id = fieldOf(requestIn(request), 'id') ?? fieldOf(requestIn(request), 'scheduleId')
      const decoded = decodeRemoteId(typeof id === 'string' ? id : undefined)
      if (decoded === undefined) return await local(request, signal)
      const payload = router.toRemote({ request: { ...requestIn(request), id: decoded.remoteId } }, decoded.nodeId)
      return router.toLocal(await router.call(decoded.nodeId, 'schedule/history', payload, signal), decoded.nodeId)
    },

    view: local => entry('schedule/view', local),
    edit: local => entry('schedule/edit', local),
    run: local => entry('schedule/run', local),

    create: local => async function create(request, signal) {
      const request_ = requestIn(request)
      const target = fieldOf(request_, 'target')
      const sessionId = fieldOf(target, 'sessionId')
      const decoded = decodeRemoteId(typeof sessionId === 'string' ? sessionId : undefined)
      if (decoded === undefined) return await local(request, signal)
      const payload = router.toRemote({ request: request_ }, decoded.nodeId)
      // Only the destination Session is unwrapped: it is the identity this route keys on.
      payload.request.target.sessionId = decoded.remoteId
      const value = await router.call(decoded.nodeId, 'schedule/create', payload, signal)
      const id = fieldOf(value, 'id')
      return typeof id === 'string' ? { ...value, id: encodeRemoteId(decoded.nodeId, id) } : value
    },

    deleteInactive: local => async function deleteInactive(...args) {
      const own = await local(...args)
      for (const runtime of router.nodes()) {
        try {
          await router.call(runtime.record.id, 'schedule/deleteInactive', {})
        } catch (error) {
          log(`fleet: schedule cleanup on ${runtime.record.name} failed: ${error?.message ?? String(error)}`)
        }
      }
      return own
    },
  })
}
