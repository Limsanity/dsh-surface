// dsh-surface — pure-core unit tests. Runnable standalone (no @deepseek-ai deps):
//   node --test test/surface-seed.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSurfaceSeed, findLastCheckpointSeq, snapTurnEnd } from '../lib/surface-seed.js'

/** Minimal DSH-shaped message projection (mirrors deriveEventMessage). */
function project(event) {
  if (event.type === 'user/message') return { role: 'user', content: event.data.content, source: event.data.source }
  if (event.type === 'system/message') return event.data.message
  if (event.type === 'assistant/message') return event.data.message
  if (event.type === 'tool/result') return { role: 'user', content: event.data.message.content, source: event.data.message.source }
  return null // chunks + boundaries project to null
}

/** Minimal DSH envelope builder (mirrors the host makeEvent, incl. v3 settlement). */
function makeEvent(partial) {
  const { type, turn, step, message, reason, stream, usage, interrupted } = partial
  let data
  let surfaceOp
  switch (type) {
    case 'turn/start': data = { turn }; break
    case 'turn/end': data = { turn, reason }; break
    case 'step/start':
    case 'step/end': data = { turn, step }; break
    case 'user/message': data = message; surfaceOp = 'append'; break
    case 'assistant/message':
      data = { turn, step, message, stream: Array.isArray(stream) ? stream : [], ...(usage === undefined ? {} : { usage }), ...(interrupted === undefined ? {} : { interrupted }) }
      surfaceOp = 'append'
      break
    case 'tool/result': data = { turn, step, message }; surfaceOp = 'append'; break
    default: throw new Error(`unexpected ${type}`)
  }
  return { type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
}

/** A fake post-compaction session: [0..3] shadowed by the checkpoint at seq 6. */
function fakeSession() {
  let seq = 0
  const events = []
  const push = (type, data, extra = {}) => {
    const event = { type, seq, time: 1000 + seq, data, ...extra }
    events.push(event)
    seq += 1
    return event
  }
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('user/message', { role: 'user', content: 'old prompt', source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', text: 'ol' } })
  push('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] } }, { surfaceOp: 'append' })
  push('user/message', { role: 'user', content: 'middle', source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // compaction replaces [0..4] (the old range) with a checkpoint
  push('compaction/start', { compactionId: 'c1', turn: 1 })
  push('compaction/summary', { compactionId: 'c1', summary: 'old recap', shadowedRange: { start: 0, end: 4 } })
  push('user/message', { role: 'user', content: '<compacted-summary>old recap</compacted-summary>', source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' } }, { surfaceOp: { op: 'replace', start: 0, end: 4 } })
  // a fresh retained turn after the checkpoint
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('user/message', { role: 'user', content: 'continue', source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }, { surfaceOp: 'append' })
  push('tool/result', { turn: 2, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'tool out' }] } }, { surfaceOp: 'append' })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return events
}

test('findLastCheckpointSeq locates the checkpoint user/message', () => {
  const events = fakeSession()
  const ckptSeq = findLastCheckpointSeq(events, (data) => data.source?.plugin === 'compact')
  assert.equal(ckptSeq, 9)
  assert.equal(events[ckptSeq].type, 'user/message')
})

test('findLastCheckpointSeq returns undefined when none', () => {
  const events = fakeSession()
  assert.equal(findLastCheckpointSeq(events.slice(0, 7), () => false), undefined)
})

test('snapTurnEnd: omitted atSeq uses last turn/end', () => {
  const events = fakeSession()
  assert.equal(snapTurnEnd(events, undefined), 16)
})

test('snapTurnEnd: atSeq snaps to the first turn/end at/after the anchor', () => {
  const events = fakeSession()
  assert.equal(snapTurnEnd(events, 7), 16)   // anchor inside turn 2 → turn 2's end
  assert.equal(snapTurnEnd(events, 0), 6)    // anchor before first turn/end → that one
  assert.equal(snapTurnEnd(events, 999), 16) // past end → last turn/end
})

test('buildSurfaceSeed groups user+assistant+tool into natural steps (no empty steps)', () => {
  // A realistic surface: checkpoint + a tool-call round.
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'c', role: 'user', content: [{ type: 'text', text: '<compacted-summary>recap</compacted-summary>' }], source: { kind: 'plugin', plugin: 'compact' } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 3, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'look at X' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
    { type: 'tool/result', seq: 5, data: { turn: 1, step: 1, message: { id: 'tr', role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc1', content: [{ type: 'text', text: 'out' }] }], source: { kind: 'tool', callId: 'tc1' } } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 6, data: { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 7, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const surfaceSeqs = [2, 3, 4, 5, 6]
  const seed = buildSurfaceSeed(events, { surfaceSeqs, ckptSeq: 2, targetEnd: 8, project, makeEvent, now: () => 0 })

  const types = seed.map(e => e.type)
  assert.deepEqual(seed.map(e => e.seq), seed.map((_, i) => i)) // contiguous from 0
  assert.ok(!types.includes('assistant/chunk'))
  assert.ok(!types.includes('compaction/start'))
  assert.equal(types[0], 'turn/start')
  assert.equal(types.at(-1), 'turn/end')
  assert.equal(types.filter(t => t === 'user/message').length, 2) // checkpoint + real prompt, grouped in step 1
  assert.equal(types.filter(t => t === 'assistant/message').length, 2)
  assert.equal(types.filter(t => t === 'tool/result').length, 1)

  // The tool result sits INSIDE the step whose assistant issued the tool-call.
  const toolIdx = types.indexOf('tool/result')
  assert.equal(types[toolIdx - 1], 'assistant/message')       // the tool-call assistant
  assert.equal(types[toolIdx + 1], 'step/end')                // same step closes
  assert.equal(seed[toolIdx].surfaceOp, 'append')
  assert.equal(seed[toolIdx].data.message.source.kind, 'tool')

  // The continuation assistant opens a NEW step in the SAME turn (no empty turn).
  const contSteps = types.filter(t => t === 'step/start')
  assert.equal(contSteps.length, 2)
  assert.equal(types.filter(t => t === 'turn/end').length, 1)
  assert.equal(types.filter(t => t === 'turn/start').length, 1)
})

test('buildSurfaceSeed drops transient per-step injections (runtime-context, skill-catalog)', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { id: 'c', role: 'user', content: [{ type: 'text', text: '<compacted-summary>recap</compacted-summary>' }], source: { kind: 'plugin', plugin: 'compact' } }, surfaceOp: 'append' },
    // transient: runtime-context snapshot
    { type: 'user/message', seq: 1, data: { id: 'r', role: 'user', content: [{ type: 'text', text: 'Current runtime context...' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } }, surfaceOp: 'append' },
    // transient: skill catalog
    { type: 'user/message', seq: 2, data: { id: 'k', role: 'user', content: [{ type: 'text', text: '<available_skills>...' }], source: { kind: 'skill-catalog', form: 'catalog' } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 3, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
  ]
  const seed = buildSurfaceSeed(events, { surfaceSeqs: [0, 1, 2, 3, 4], ckptSeq: 0, targetEnd: 4, project, makeEvent, now: () => 0 })
  const userMessages = seed.filter(e => e.type === 'user/message')
  // checkpoint + real "hello" survive; the two transient injections are dropped.
  assert.equal(userMessages.length, 2)
  assert.ok(!userMessages.some(m => m.data.content?.some?.(b => b.text?.includes('Current runtime context'))))
  assert.ok(!userMessages.some(m => m.data.content?.some?.(b => b.text?.includes('available_skills'))))
  assert.ok(seed.some(e => e.type === 'assistant/message'))
})

test('buildSurfaceSeed carries the v3 assistant settlement fields (stream/usage/interrupted)', () => {
  const stream = [{ type: 'text', text: 'hi' }]
  const usage = { inputTokens: 10, outputTokens: 2 }
  const events = [
    { type: 'user/message', seq: 0, data: { id: 'c', role: 'user', content: [{ type: 'text', text: 'recap' }], source: { kind: 'plugin', plugin: 'compact' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream, usage, interrupted: true }, surfaceOp: 'append' },
  ]
  const seed = buildSurfaceSeed(events, { surfaceSeqs: [0, 1], ckptSeq: 0, targetEnd: 1, project, makeEvent, now: () => 0 })
  const assistant = seed.find(e => e.type === 'assistant/message')
  // Without this array the v3 seed validator rejects the whole child session.
  assert.ok(Array.isArray(assistant.data.stream))
  assert.deepEqual(assistant.data.stream, stream)
  assert.deepEqual(assistant.data.usage, usage)
  assert.equal(assistant.data.interrupted, true)
})

test('buildSurfaceSeed defaults a missing source stream to an empty array', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { id: 'c', role: 'user', content: [{ type: 'text', text: 'recap' }], source: { kind: 'plugin', plugin: 'compact' } }, surfaceOp: 'append' },
    // A pre-v3-shaped source event: no `stream` on data.
    { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
  ]
  const seed = buildSurfaceSeed(events, { surfaceSeqs: [0, 1], ckptSeq: 0, targetEnd: 1, project, makeEvent, now: () => 0 })
  const assistant = seed.find(e => e.type === 'assistant/message')
  assert.deepEqual(assistant.data.stream, [])
  assert.equal('usage' in assistant.data, false)
  assert.equal('interrupted' in assistant.data, false)
})

test('buildSurfaceSeed drops the source system/message node (the child re-derives its own)', () => {
  const events = [
    { type: 'system/message', seq: 0, data: { turn: 1, step: 1, message: { id: 's', role: 'system', content: [{ type: 'text', text: 'STALE PARENT PROMPT' }], source: { kind: 'plugin', plugin: 'dsh-agent-instructions' } } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 1, data: { id: 'c', role: 'user', content: [{ type: 'text', text: 'recap' }], source: { kind: 'plugin', plugin: 'compact' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, surfaceOp: 'append' },
  ]
  const seed = buildSurfaceSeed(events, { surfaceSeqs: [0, 1, 2], ckptSeq: 0, targetEnd: 2, project, makeEvent, now: () => 0 })
  assert.ok(!seed.some(e => e.type === 'system/message'))
  // Never re-labelled as an assistant message (that would fail role/source validation).
  assert.ok(!seed.some(e => e.type === 'assistant/message' && e.data.message.role !== 'assistant'))
  assert.ok(!JSON.stringify(seed).includes('STALE PARENT PROMPT'))
  assert.equal(seed.filter(e => e.type === 'assistant/message').length, 1)
})
