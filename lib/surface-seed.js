// dsh-surface — pure core.
// Zero DSH imports: every DSH-specific helper is injected, so this module is
// unit-testable standalone and wired to @deepseek-ai/dsh-* in lib/index.js.
//
// Responsibilities:
//   * locate the last compaction checkpoint (a user/message whose data passes isCheckpoint)
//   * snap an atSeq anchor to a completed turn/end boundary (mirrors apiproxy fork)
//   * re-emit the surface from the checkpoint to the target turn as a clean,
//     contiguous, balanced seed (no chunks, no shadowed history, no dangling refs)

/** The seq of the last compaction checkpoint user/message, or undefined. */
export function findLastCheckpointSeq(events, isCheckpoint) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'user/message' && isCheckpoint(event.data)) return event.seq
  }
  return undefined
}

/** Snap an atSeq anchor to a completed turn/end seq (mirrors the fork rule). */
export function snapTurnEnd(events, atSeq) {
  const lastTurnEnd = () => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'turn/end') return events[index].seq
    }
    return undefined
  }
  if (atSeq === undefined) return lastTurnEnd()
  for (const event of events) {
    if (event.type === 'turn/end' && event.seq >= atSeq) return event.seq
  }
  // atSeq after the last closed turn (an open turn) or past the log: cut at the
  // last completed turn so the child is always a balanced boundary.
  return lastTurnEnd()
}

/**
 * Copy the session-format-v3 settlement fields an `assistant/message` must carry
 * into a seed. Since v3 the event embeds its exact model stream, and
 * `data.stream` being an array is a hard construction invariant; `usage` and
 * `interrupted` travel with it. The seed re-emits the SOURCE event's own stream
 * (never a synthesized one), so the child's stored settlement stays truthful.
 *
 * @param source - the source session event projected into this seed node.
 * @returns the settlement fields to merge into the emitted partial.
 */
function assistantSettlement(source) {
  const data = source?.data
  if (data === null || typeof data !== 'object') return { stream: [] }
  return {
    stream: Array.isArray(data.stream) ? data.stream : [],
    ...(data.usage === undefined ? {} : { usage: data.usage }),
    ...(data.interrupted === undefined ? {} : { interrupted: data.interrupted }),
  }
}

/**
 * Re-emit the surface nodes in `[ckptSeq .. targetEnd]` as a contiguous,
 * balanced seed starting at seq 0.
 *
 * @param events - the source session's full event log (seq is array index).
 * @param opts
 *   surfaceSeqs - ordered surface node seqs (the session's current surface).
 *   ckptSeq     - inclusive first retained surface seq (the last checkpoint).
 *   targetEnd   - inclusive last retained surface seq (a turn/end boundary).
 *   project     - (event) => Message | null; the per-node surface projection.
 *   makeEvent   - (partial) => { type; data?; surfaceOp? } for one emitted event.
 *   now         - timestamp factory (default Date.now).
 * @returns the new contiguous, balanced seed (seq 0..N).
 */
export function buildSurfaceSeed(events, {
  surfaceSeqs,
  ckptSeq,
  targetEnd,
  project,
  makeEvent,
  now = Date.now,
}) {
  const selected = surfaceSeqs.filter((seq) => seq >= ckptSeq && seq <= targetEnd)
  const out = []
  let seq = 0
  const push = (partial) => {
    const event = makeEvent(partial)
    out.push({ ...event, seq, time: now() })
    seq += 1
  }

  let turn = 0
  let step = 0
  let inTurn = false
  let inStep = false
  // true while the open step has gotten its entered user message(s) but not its
  // assistant yet — used to GROUP consecutive user/injected messages into the
  // same step instead of fragmenting them.
  let awaitingAssistant = false

  const closeStep = () => {
    if (!inStep) return
    push({ type: 'step/end', turn, step })
    inStep = false
  }
  const closeTurn = () => {
    closeStep()
    if (!inTurn) return
    push({ type: 'turn/end', turn, reason: { kind: 'completed' } })
    inTurn = false
  }
  const openTurn = () => {
    closeTurn()
    turn += 1
    step = 0
    inTurn = true
    push({ type: 'turn/start', turn })
  }
  const openStep = () => {
    closeStep()
    step += 1
    inStep = true
    awaitingAssistant = false
    push({ type: 'step/start', turn, step })
  }

  const isToolResult = (message) => message?.source?.kind === 'tool'
    || (Array.isArray(message?.content) && message.content.some((block) => block.type === 'tool-result'))
  const hasToolCall = (message) => Array.isArray(message?.content)
    && message.content.some((block) => block.type === 'tool-call')
  // Transient per-step injections that a FRESH session re-derives itself: the
  // runtime-context snapshot (@deepseek-ai/dsh-system-prompt) and the skill
  // catalog. Carrying a stale copy into the child only adds outdated context.
  const isTransientInjection = (message) => {
    const source = message?.source
    if (source?.kind === 'skill-catalog') return true
    if (source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt') return true
    return false
  }

  for (const surfaceSeq of selected) {
    const source = events[surfaceSeq]
    const message = project(source)
    if (!message) continue
    // A `system/message` surface node is the source session's OWN rendered system
    // prompt. The child composes its own from its agent preset, so carrying the
    // parent's would pin stale instructions into the new session — drop it.
    // (It also cannot be re-emitted as an assistant message: the seed validator
    // requires role/source to match the event type exactly.)
    if (message.role === 'system') continue
    if (isTransientInjection(message)) continue
    const isTool = isToolResult(message)
    const isUser = message.role === 'user' && !isTool

    if (isTool) {
      // A tool result belongs to the step that requested it (its assistant).
      if (!inTurn) openTurn()
      if (!inStep) openStep()
      push({ type: 'tool/result', turn, step, message })
      continue
    }

    if (isUser) {
      if (!inTurn || awaitingAssistant === false) {
        // Not waiting for an assistant: the previous step already closed, so a
        // fresh user message begins a new turn (+ step).
        openTurn()
        openStep()
      } else if (!inStep) {
        openStep()
      }
      push({ type: 'user/message', turn, step, message })
      awaitingAssistant = true
      continue
    }

    // assistant
    if (!inTurn) {
      openTurn()
      openStep()
    } else if (awaitingAssistant === false) {
      // The current step already produced its assistant (a tool-call round), so
      // this is the continuation assistant — a NEW step in the same turn.
      openStep()
    } else if (!inStep) {
      openStep()
    }
    push({ type: 'assistant/message', turn, step, message, ...assistantSettlement(source) })
    awaitingAssistant = false
    if (!hasToolCall(message)) {
      // A final assistant closes the step and the turn.
      closeTurn()
    }
    // A tool-call assistant keeps the step open to receive its tool results; the
    // following continuation assistant opens a new step (handled above).
  }

  if (inTurn) closeTurn()
  return out
}
