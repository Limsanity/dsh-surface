// dsh-surface — host half.
// Serves POST /api/dsh-surface/fork: builds a lightweight child session seeded
// from the LAST compaction checkpoint to a target turn (surface re-seed), then
// creates a new Agent/Session via ctx.agents.create.
//
// A link-installed plugin's host cannot resolve bare `@deepseek-ai/dsh-*` imports
// by name, so `scripts/link-dev-deps.sh` symlinks the HOST copies of those
// packages into this checkout's `node_modules` (run after `pnpm install`). That
// lets the host import the REAL compaction-checkpoint predicate below instead of
// mirroring dsh internals. The surface fold/projection still uses the LIVE
// session's own API — `session.surface.nodes` and `session.deriveEventMessage` —
// plus injected `ctx` services for the rest.
import { randomUUID } from 'node:crypto'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { buildSurfaceSeed, findLastCheckpointSeq, snapTurnEnd } from './surface-seed.js'
import { makeEvent } from './emit.js'

// Compaction-checkpoint predicate for `findLastCheckpointSeq`: `data` is a
// message payload, and the host's `isCompactCheckpointSource` expects its
// `.source` (link-dev-deps resolves the import to the HOST copy).
const isCheckpointSource = (data) => data?.source != null && isCompactCheckpointSource(data.source)

export const name = 'dsh-surface'

export const inject = [
  'webServer',
  'sessions',
  'agents',
]

const API_PREFIX = '/api/dsh-surface'

// ---------------------------------------------------------------------------
// HTTP plumbing (mirrors dsh-worktree-panel)
// ---------------------------------------------------------------------------
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function routeHandler(fn, { mutate = false } = {}) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {})
      return
    }
    if (mutate && req.method === 'POST' && !isLoopback(req)) {
      sendJson(res, 403, { error: '变更操作仅限本机（127.0.0.1）调用' })
      return
    }
    try {
      const body = req.method === 'POST' ? await readJson(req) : {}
      const [code, payload] = await fn(body, req)
      sendJson(res, code, payload)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }
}

// ---------------------------------------------------------------------------
// session read + composition
// ---------------------------------------------------------------------------
async function readSession(ctx, sessionId) {
  const attached = ctx.sessions?.get?.(sessionId)
  // 0.1.5-rc.1 removed the `session.events` getter in favour of an explicit
  // `snapshotEvents()` read (dsh-session Session.snapshotEvents).
  if (attached) return { session: attached, header: attached.header, events: attached.snapshotEvents(), live: true }
  // Surface fold/projection uses the LIVE session's own API (no dsh-session
  // import), so a cold (unloaded) session cannot be surface-forked here.
  throw new Error(`cannot surface fork "${sessionId}": session is not live (open it in the Web UI first)`)
}

/** Compose the child agent with the same preset the source session ran under. */
async function composeAgentSetup(ctx, { header }) {
  const presets = ctx.get('agentPresets')
  if (!presets) return { agentPreset: undefined, setup: async () => {} }
  // Recorded preset wins; otherwise the preset roster's default.
  const resolvedId = (await presets.resolve(header.agentPreset)).id
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx) => { await presets.mount(agentCtx, resolvedId) },
  }
}

/**
 * Resolve the workspace a session belongs to, so the surface-fork child can be
 * grouped with its source (mirrors the api-proxy `forkWorkspace`). A direct
 * membership wins; a subagent source joins the nearest owning ancestor instead.
 */
async function resolveWorkspace(ctx, header) {
  const workspaces = ctx.get('workspaceRegistry')?.list?.() ?? []
  const direct = workspaces.find(ws => ws.sessionIds?.includes(header.id))
  if (direct !== undefined || header.origin !== 'subagent') return direct
  const query = ctx.get('sessionQuery')
  if (!query?.traceSession) return undefined
  const lineage = await query.traceSession(header.id)
  for (const ancestor of lineage.ancestors) {
    const ws = workspaces.find(candidate => candidate.sessionIds?.includes(ancestor.header.id))
    if (ws !== undefined) return ws
  }
  return undefined
}

/** Inherit the source session's model route from the latest request/header. */
function deriveAgentOptions(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type !== 'request/header') continue
    const { provider, model } = events[index].data.header?.config ?? {}
    if (provider || model) return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
  }
  return undefined
}

/** The seq of a finalized assistant/message carrying `messageId`, or undefined. */
function findMessageSeq(events, messageId) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'assistant/message' && event.data.message?.id === messageId) return event.seq
  }
  return undefined
}

// ---------------------------------------------------------------------------
// why there is NO on-demand compaction here
// ---------------------------------------------------------------------------
// Until 0.1.6 this plugin tried to CREATE a compaction checkpoint when a session
// had none, so the action also worked on a session that had never compacted:
//
//     const compaction = ctx.get('compaction')
//     if (agent && compaction?.compactNow) await compaction.compactNow(agent, signal)
//
// That branch never actually ran. Both 0.1.1-rc.2 and 0.1.5-rc.1 ship the same
// split: `dsh-web-app` disables the host-plane `compaction-basic` row, and the
// backend is mounted per AGENT PRESET inside an isolated Cordis realm
// (`isolate: { compaction: true }` in each shipped `agent-presets/<preset>/agent.cordis.yml`).
// A host plugin cannot see that realm — not even through the live agent's scoped
// `agent.ctx`, which is host-rooted rather than a child of the preset realm — so
// `ctx.get('compaction')` is legitimately `undefined` and the `if` was always false.
//
// It CAN be reached through the command registry (`ctx.commands.execute(agent,
// '/compact', …)`), and 0.1.6 briefly did exactly that. It was removed on purpose:
// a button labelled "continue this conversation in a new session" must not rewrite
// the source session's history. `/compact` appends a summary and a checkpoint that
// permanently shadow part of the log, and it costs a model call — neither is
// something to trigger from a button whose label promises a new session, and if
// the clicked message is itself folded into that summary the fork can no longer
// be honoured at all.
//
// So: report the missing checkpoint and let the user decide. Compaction stays an
// explicit, visible action (`/compact`, or the automatic pressure threshold).

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------
/**
 * Build a lightweight child session from the last compaction checkpoint to a
 * target turn, then create a new Agent/Session. Throws a classified Error on
 * failure (see `code`), which the route maps to a 4xx/5xx payload.
 */
async function surfaceFork(ctx, { sessionId, messageId, atSeq, increaseTitle = true }) {
  const source = await readSession(ctx, sessionId)
  const session = source.session
  const events = source.events

  // Read-only: a missing checkpoint is reported, never created. See the note
  // above "why there is NO on-demand compaction here".
  const ckptSeq = findLastCheckpointSeq(events, isCheckpointSource)
  if (ckptSeq === undefined) {
    const err = new Error('该会话尚无压缩点，无法 surface fork：请先执行 /compact（或等自动压缩触发），并在压缩点之后再完成至少一轮对话')
    err.code = 'no-compaction-checkpoint'
    throw err
  }

  // Target turn: prefer the turn containing a finalized message (by messageId),
  // else the atSeq anchor, else the last completed turn.
  let anchor = atSeq
  if (messageId !== undefined) {
    const messageSeq = findMessageSeq(events, messageId)
    if (messageSeq === undefined) {
      const err = new Error(`assistant/message "${messageId}" not found in session "${sessionId}"`)
      err.code = 'message-not-found'
      throw err
    }
    anchor = messageSeq
  }
  const targetEnd = snapTurnEnd(events, anchor)
  if (targetEnd === undefined || targetEnd < ckptSeq) {
    const err = new Error(`no completed turn boundary at/after the checkpoint for session "${sessionId}"`)
    err.code = 'no-target-turn'
    throw err
  }

  // Use the LIVE session's own surface + projection (no dsh-session import).
  const surfaceSeqs = session.surface?.nodes ?? []
  const seed = buildSurfaceSeed(events, {
    surfaceSeqs,
    ckptSeq,
    targetEnd,
    project: (event) => session.deriveEventMessage(event),
    makeEvent,
  })

  const composition = await composeAgentSetup(ctx, source)
  // Normal session id, matching the official fork convention: lineage is NOT
  // encoded in the id — it is carried by `meta.parentSession` below (so this
  // child is a standard `session-<uuid>` that every session-id validator and
  // the official sidebar/API accept). A `-surface-` composite id would break
  // strict session-id validators.
  const childId = `session-${randomUUID()}`
  await ctx.agents.create({
    sessionId: childId,
    seed,
    // Session format v3 replaced `meta.seedLength` with a DURABLE lineage cut:
    // `meta.isSeeded` marks the fork and `inheritedEventCount` is the exact
    // inherited prefix length. Session's constructor requires it to EQUAL the
    // constructor seed length ("seeded session constructor seed must equal its
    // inherited prefix") and then appends its own `session/end-seed` marker at
    // the cut — the same contract the official `session.fork` uses.
    inheritedEventCount: seed.length,
    meta: {
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      parentSession: sessionId,
      isSeeded: true,
      ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
    },
    agentOptions: deriveAgentOptions(events),
    setup: composition.setup,
  })
  // Group the child under the source's workspace (mirrors the official fork's
  // `workspace.attachSession` step). Best-effort: attach failure must not lose
  // the already-published child.
  let workspaceAttached = false
  const workspace = await resolveWorkspace(ctx, source.header)
  if (workspace?.attachSession) {
    try {
      await workspace.attachSession(childId)
      workspaceAttached = true
    } catch (error) {
      ctx.logger?.warn?.(`dsh-surface: attach child "${childId}" to workspace failed: ${String(error?.message ?? error)}`)
    }
  }
  return { childId, seedLength: seed.length, ckptSeq, targetEnd, workspaceAttached }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const cfg = config ?? {}
  if (cfg.enabled === false) return
  const endpointPath = cfg.endpointPath ?? API_PREFIX

  const routes = [
    {
      kind: 'exact',
      path: `${endpointPath}/fork`,
      handler: routeHandler(async (body) => {
        const { sessionId, messageId, atSeq, increaseTitle } = body ?? {}
        try {
          const result = await surfaceFork(ctx, { sessionId, messageId, atSeq, increaseTitle })
          return [200, { ok: true, ...result }]
        } catch (error) {
          const code = error.code ?? 'internal'
          const status = code === 'no-compaction-checkpoint' ? 422 : 400
          return [status, { ok: false, code, message: String(error?.message ?? error) }]
        }
      }, { mutate: true }),
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  })
}
