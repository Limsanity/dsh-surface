// dsh-surface — self-contained dsh-compatible surface helpers (zero imports).
// The dsh host resolves bare `@deepseek-ai/dsh-*` imports ONLY for real npm
// packages (via the .pnpm store); a link-installed plugin's host cannot resolve
// them by name. So the host re-derives the small, well-defined surface pieces
// here and consumes the rest through injected `ctx` services. These mirror
// `@deepseek-ai/dsh-session`'s surface.ts semantics; `test/runtime-validation.mjs`
// cross-checks them against the REAL functions.

/** Surface-eligible message-producing event types (mirror of SurfaceEventType). */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Compaction-checkpoint predicate (mirror of `isCompactCheckpointSource`). */
export function isCompactCheckpointSource(source) {
  return source !== null && typeof source === 'object'
    && source.kind === 'plugin' && source.plugin === 'compact'
}

/**
 * Project one event to the model-visible message it derives, or null when it
 * produces none (mirror of `deriveEventMessage`).
 */
export function deriveEventMessage(event) {
  switch (event.type) {
    case 'user/message': return event.data
    case 'assistant/message':
      return event.data.message.content.length === 0 ? null : event.data.message
    case 'tool/result': return event.data.message
    default: return null
  }
}

/**
 * Fold the ordered surface node seqs, honoring append and positional replace
 * (compaction checkpoint / tool-result prune) ops. Mirror of `foldSurface()`
 * with only the node computation (provenance/tool-pairing validation is the
 * real `Session`'s job when the child seed is constructed).
 * @returns ordered `readonly number[]` of surface node seqs.
 */
export function foldSurfaceNodes(events) {
  const nodes = []
  for (const event of events) {
    if (!SURFACE_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    const startIdx = nodes.indexOf(op.start)
    const endIdx = nodes.indexOf(op.end)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      throw new Error(`surface-fold: invalid replace range ${op.start}..${op.end}`)
    }
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
  }
  return nodes
}
