// dsh-surface — runtime validation against the REAL @deepseek-ai/dsh-session.
//   node test/runtime-validation.mjs
//
// Bare `@deepseek-ai/*` specifiers resolve through this checkout's own
// node_modules, which `scripts/link-dev-deps.sh` symlinks to the DSH HOST's
// copies — so this exercises the exact Session implementation the plugin runs
// against (not a private copy).
//
// Two independent checks, because the 0.1.1-rc.2 → 0.1.5-rc.1 break was in the
// SEED CONTRACT, not in the fold logic:
//
//   A. SYNTHETIC — a hand-built source session with a compaction checkpoint:
//      build the child seed and require real `Session.create` to accept it, then
//      require it to reconstruct the same model-visible surface.
//
//   B. REAL DATA — replay an actual stored v3 session log from the running
//      DSH_HOME, cut a surface fork at a synthetic checkpoint inside it, and
//      require the real seed boundary to accept the result with the v3 seeded
//      header contract (`meta.isSeeded` + `inheritedEventCount === seed.length`).
//      This is what catches "seed assistant/message ... invalid settlement
//      fields" against real provider data instead of a toy transcript.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { buildSurfaceSeed, findLastCheckpointSeq, snapTurnEnd } from '../lib/surface-seed.js'
import { makeEvent } from '../lib/emit.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** Mirrors the host's one-line compaction-checkpoint predicate. */
const isSyntheticCheckpoint = (data) => data?.source?.kind === 'plugin' && data?.source?.plugin === 'compact'

/** A v3-shaped assistant settlement (the event embeds its exact model stream). */
const STREAM = [{ type: 'text', text: 'streamed' }]

// ---------------------------------------------------------------------------
// A. synthetic source session with a compaction checkpoint
// ---------------------------------------------------------------------------
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
  const oldAssistant = push('assistant/message', { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'old' }], source: { kind: 'model', provider: 'prov', model: 'model' } }, stream: STREAM }, { surfaceOp: 'append' })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const compStart = push('compaction/start', { compactionId: 'cx', turn: 1 })
  const compSummary = push('compaction/summary', { compactionId: 'cx', summary: 'old recap', shadowedRange: { start: oldUser.seq, end: oldAssistant.seq } })
  push('user/message', {
    id: 'm3',
    role: 'user',
    content: [{ type: 'text', text: '<compacted-summary>old recap</compacted-summary>' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'cx' },
  }, {
    surfaceOp: { op: 'replace', startSeq: oldUser.seq, endSeq: oldAssistant.seq },
    sourceEventSeqs: [compStart.seq, compSummary.seq, oldUser.seq, oldAssistant.seq],
  })
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('user/message', { id: 'm4', role: 'user', content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('assistant/message', { turn: 2, step: 1, message: { id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'prov', model: 'model' } }, stream: STREAM }, { surfaceOp: 'append' })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { session: Session.create(SessionId('src'), events), events }
}

/** Run the host's actual path: LIVE session API + the pure seed/emit modules. */
function surfaceSeedOf(session, events, { ckptSeq, targetEnd }) {
  return buildSurfaceSeed(events, {
    surfaceSeqs: session.surface.nodes,
    ckptSeq,
    targetEnd,
    project: (event) => session.deriveEventMessage(event),
    makeEvent,
  })
}

/** The v3 seeded-header contract `ctx.agents.create` applies (see lib/index.js). */
function createChild(seed, parent, cwd) {
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('child'),
    createdAt: 5000,
    isSeeded: true,
    parentSession: SessionId(parent),
    ...(cwd === undefined ? {} : { cwd }),
  }
  return Session.create(SessionId('child'), seed, header, seed.length)
}

console.log('=== A. synthetic source session (compaction checkpoint) ===')
const { session: source, events } = buildSourceSession()
const sourceMessages = source.deriveMessages().map((m) => ({ role: m.role, content: m.content }))
console.log('  source surface.nodes:', source.surface.nodes.join(','))
console.log('  source deriveMessages():', sourceMessages.map((m) => m.role).join(','))

const ckptSeq = findLastCheckpointSeq(events, isSyntheticCheckpoint)
const targetEnd = snapTurnEnd(events, undefined)
console.log(`  ckptSeq=${ckptSeq} targetEnd=${targetEnd}`)

const childSeed = surfaceSeedOf(source, events, { ckptSeq, targetEnd })
let child
try {
  child = createChild(childSeed, 'src', '/tmp/src')
  check('real Session.create accepts the re-emitted seed', true)
} catch (error) {
  check('real Session.create accepts the re-emitted seed', false, String(error?.message ?? error))
}

if (child !== undefined) {
  const childMessages = child.deriveMessages().map((m) => ({ role: m.role, content: m.content }))
  check('seed seq contiguous from 0', childSeed.every((e, i) => e.seq === i))
  check('no assistant/chunk leaked into the seed', !child.snapshotEvents().some((e) => e.type === 'assistant/chunk'))
  check('no compaction markers leaked into the seed', !child.snapshotEvents().some((e) => e.type.startsWith('compaction')))
  check('every assistant/message carries an array stream',
    child.snapshotEvents().filter((e) => e.type === 'assistant/message').every((e) => Array.isArray(e.data.stream)))
  check('child surface === source post-compaction surface',
    JSON.stringify(childMessages) === JSON.stringify(sourceMessages))
  check('header.isSeeded is true', child.header.isSeeded === true)
  check('inheritedEventCount === seed.length',
    child.inheritedEventCount === childSeed.length, `inherited=${child.inheritedEventCount} seed=${childSeed.length}`)
  const endSeed = child.snapshotEvents().filter((e) => e.type === 'session/end-seed')
  check('constructor appended exactly one session/end-seed at the cut',
    endSeed.length === 1 && endSeed[0].seq === childSeed.length)
}

// ---------------------------------------------------------------------------
// B. a REAL stored v3 session log from the running DSH_HOME
// ---------------------------------------------------------------------------
console.log('\n=== B. real stored v3 session log ===')
const root = process.env.DSH_HOME ?? join(process.env.HOME, '.dsh-next')
const sessionsDir = join(root, 'sessions')

/** Decompress one session log (zstd via the CLI — the CLI is on PATH here). */
function readLog(path) {
  if (path.endsWith('.zstd')) return execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 }).toString('utf8')
  return readFileSync(path, 'utf8')
}

function findLogs(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLogs(full))
    else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full)
  }
  return out
}

const logs = findLogs(sessionsDir)
console.log(`  found ${logs.length} session log(s) under ${sessionsDir}`)

// Largest log = the most provider-real transcript available locally.
const ranked = logs
  .map((path) => ({ path, text: readLog(path) }))
  .map((entry) => ({ ...entry, lines: entry.text.split('\n').filter(Boolean) }))
  .sort((a, b) => b.lines.length - a.lines.length)

if (ranked.length === 0) {
  check('a real v3 session log is available to validate against', false, `none under ${sessionsDir}`)
} else {
  const best = ranked[0]
  console.log(`  using ${best.path} (${best.lines.length} records)`)
  let sourceSession
  let realEvents
  try {
    realEvents = best.lines.map((line) => JSON.parse(line)).filter((e) => typeof e.seq === 'number')
    realEvents.sort((a, b) => a.seq - b.seq)
    sourceSession = Session.create(SessionId('real'), realEvents)
    check('real v3 log replays into a Session', true)
  } catch (error) {
    check('real v3 log replays into a Session', false, String(error?.message ?? error))
  }

  if (sourceSession !== undefined) {
    const nodes = sourceSession.surface.nodes
    console.log(`  surface nodes: ${nodes.length}, events: ${realEvents.length}`)
    // Stand in for a compaction checkpoint: cut at the SECOND surface node so the
    // slice has real assistant settlements and at least one full turn.
    const cutNode = nodes.length > 1 ? nodes[1] : nodes[0]
    const realTarget = snapTurnEnd(realEvents, undefined)
    const realSeed = surfaceSeedOf(sourceSession, realEvents, { ckptSeq: cutNode, targetEnd: realTarget })
    console.log(`  ckptSeq=${cutNode} targetEnd=${realTarget} → seed length ${realSeed.length}`)
    check('real-data seed is non-empty', realSeed.length > 0)
    check('real-data seed has an assistant/message',
      realSeed.some((e) => e.type === 'assistant/message'))
    try {
      const realChild = createChild(realSeed, 'real', sourceSession.header.cwd)
      check('real Session.create accepts a real-data surface seed', true)
      check('real-data child inheritedEventCount === seed.length',
        realChild.inheritedEventCount === realSeed.length)
      const childMsgs = realChild.deriveMessages().map((m) => ({ role: m.role, content: m.content }))
      const srcMsgs = sourceSession.deriveMessages().map((m) => ({ role: m.role, content: m.content }))
      console.log(`  source messages: ${srcMsgs.length}, child messages: ${childMsgs.length}`)
      // The seed deliberately DROPS the source's transient per-step injections
      // (runtime-context snapshots, skill catalogs), so the child's history is an
      // ordered SUBSEQUENCE of the source's — never a superset, never reordered,
      // never a synthesized message. Assert exactly that, plus that the retained
      // tail still ends on the source's real final message.
      let cursor = 0
      for (const message of childMsgs) {
        const target = JSON.stringify(message)
        while (cursor < srcMsgs.length && JSON.stringify(srcMsgs[cursor]) !== target) cursor += 1
        if (cursor >= srcMsgs.length) break
        cursor += 1
      }
      const lastMatches = childMsgs.length > 0
        && JSON.stringify(childMsgs[childMsgs.length - 1]) === JSON.stringify(srcMsgs[srcMsgs.length - 1])
      check('real-data child history is an ordered subsequence of the source surface',
        lastMatches && cursor > 0, `matched all ${childMsgs.length} child messages`)
      // The source's head surface node is its OWN rendered system prompt. The child
      // composes its own from its agent preset, so carrying it forward would pin a
      // stale prompt — and re-emitting it as an assistant message (the pre-fix
      // behaviour) fails role/source validation outright.
      const head = realEvents[nodes[0]]
      check('real-data source head surface node is a system/message',
        head?.type === 'system/message', String(head?.type))
      check('real-data child carries no system/message',
        !realChild.snapshotEvents().some((e) => e.type === 'system/message'))
    } catch (error) {
      check('real Session.create accepts a real-data surface seed', false, String(error?.message ?? error))
    }
  }
}

console.log(failures === 0 ? '\nRUNTIME VALIDATION: PASS' : `\nRUNTIME VALIDATION: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
