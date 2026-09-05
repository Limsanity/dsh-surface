// dsh-surface — runtime validation against REAL @deepseek-ai/dsh-session.
//   node test/runtime-validation.mjs
//
// This builds a real `Session` (harness packages, imported by absolute path so
// no harness source is touched), then validates the plugin's SELF-CONTAINED
// host path (lib/dsh-compat + surface-seed + emit) by:
//   1. cross-checking dsh-compat's fold/project/checkpoint against the real
//      @deepseek-ai/dsh-session functions, and
//   2. asserting the re-emitted child seed passes real `Session.create` and
//      reconstructs the SAME model-visible surface as the post-compaction source.
import { Session, SessionId, foldSurface, deriveEventMessage as realProject } from '../../deepseek-harness/packages/core/session/lib/index.js'
import { buildSurfaceSeed, findLastCheckpointSeq, snapTurnEnd } from '../lib/surface-seed.js'
import { makeEvent } from '../lib/emit.js'
import { deriveEventMessage, foldSurfaceNodes, isCompactCheckpointSource } from '../lib/dsh-compat.js'
import { compactCheckpointSource, CompactionId, isCompactCheckpointSource as realCheckpoint } from '../../deepseek-harness/packages/compaction/compaction/lib/index.js'

// --- build a minimal, valid source session with a compaction checkpoint ---
function buildSourceSession() {
  const events = []
  let seq = 0
  const push = (type, data, extra = {}) => {
    const event = { type, seq, time: 1000 + seq, data, ...extra }
    events.push(event)
    seq += 1
    return event
  }
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  const oldUser = push('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'v1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', text: 'ol' } })
  const oldAssistant = push('assistant/message', { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'old' }], source: { kind: 'model', provider: 'prov', model: 'model' } } }, { surfaceOp: 'append' })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const compStart = push('compaction/start', { compactionId: 'cx', turn: 1 })
  const compSummary = push('compaction/summary', { compactionId: 'cx', summary: 'old recap', shadowedRange: { start: oldUser.seq, end: oldAssistant.seq } })
  push('user/message', {
    id: 'm3',
    role: 'user',
    content: [{ type: 'text', text: '<compacted-summary>old recap</compacted-summary>' }],
    source: compactCheckpointSource(CompactionId('cx')),
  }, {
    surfaceOp: { op: 'replace', start: oldUser.seq, end: oldAssistant.seq },
    sourceEventSeqs: [compStart.seq, compSummary.seq, oldUser.seq, oldAssistant.seq],
  })
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('user/message', { id: 'm4', role: 'user', content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('assistant/message', { turn: 2, step: 1, message: { id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'prov', model: 'model' } } }, { surfaceOp: 'append' })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { session: Session.create(SessionId('src'), events), events }
}

const { session: source, events } = buildSourceSession()
const sourceMessages = source.deriveMessages().map(m => ({ role: m.role, content: m.content }))
console.log('source surface nodes (real foldSurface):', foldSurface(events).nodes)
console.log('source deriveMessages():', sourceMessages.map(m => `${m.role}:${JSON.stringify(m.content)}`))

// --- (1) cross-check dsh-compat against the REAL dsh-session functions ---
const compatNodes = foldSurfaceNodes(events)
const realNodes = foldSurface(events).nodes
console.log('dsh-compat foldSurfaceNodes === real foldSurface.nodes:', JSON.stringify(compatNodes) === JSON.stringify(realNodes))
if (JSON.stringify(compatNodes) !== JSON.stringify(realNodes)) process.exit(1)

let projectMatches = true
for (const event of events) {
  const a = deriveEventMessage(event)
  const b = realProject(event)
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    projectMatches = false
    console.error('  mismatch at seq', event.seq, a, b)
  }
}
console.log('dsh-compat deriveEventMessage === real deriveEventMessage:', projectMatches)

const chkEvent = events.find(e => e.type === 'user/message' && e.data.source?.plugin === 'compact')
const checkpointMatches = isCompactCheckpointSource(chkEvent.data.source) === realCheckpoint(chkEvent.data.source)
console.log('dsh-compat isCompactCheckpointSource === real:', checkpointMatches)

if (!projectMatches || !checkpointMatches) process.exit(1)

// --- (2) run the plugin's FULL self-contained host path ---
const ckptSeq = findLastCheckpointSeq(events, (data) => isCompactCheckpointSource(data.source))
const targetEnd = snapTurnEnd(events, undefined)
const surfaceSeqs = foldSurfaceNodes(events)
const childSeed = buildSurfaceSeed(events, {
  surfaceSeqs,
  ckptSeq,
  targetEnd,
  project: deriveEventMessage,
  makeEvent,
})

let child
try {
  child = Session.create(SessionId('child'), childSeed)
} catch (error) {
  console.error('FAIL: Session.create rejected the re-emitted seed\n', error)
  process.exit(1)
}

const childTypes = child.events.map(e => e.type)
const childMessages = child.deriveMessages().map(m => ({ role: m.role, content: m.content }))
const surfacePreserved = JSON.stringify(childMessages) === JSON.stringify(sourceMessages)
const contiguous = childSeed.every((e, i) => e.seq === i)
const noChunks = !childTypes.includes('assistant/chunk')
const noCompaction = !childTypes.some(t => t.startsWith('compaction'))

console.log('child has chunks:', noChunks, '| child has compaction markers:', noCompaction)
console.log('child seq contiguous from 0:', contiguous)
console.log('child deriveMessages() === source post-compaction surface:', surfacePreserved)

const ok = noChunks && noCompaction && contiguous && surfacePreserved
console.log(ok ? '\nRUNTIME VALIDATION: PASS' : '\nRUNTIME VALIDATION: FAIL')
process.exit(ok ? 0 : 1)
