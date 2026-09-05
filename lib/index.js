// dsh-surface — host half.
// Serves POST /api/dsh-surface/fork: builds a lightweight child session seeded
// from the LAST compaction checkpoint to a target turn (surface re-seed), then
// creates a new Agent/Session via ctx.agents.create.
//
// IMPORTANT: no bare `@deepseek-ai/dsh-*` imports. A link-installed plugin's
// host cannot resolve those by name (only real npm packages get a .pnpm store),
// so this module re-derives the small surface pieces via ./dsh-compat.js and
// consumes the rest through the injected `ctx` services (sessions / agents /
// sessionPersistence / webServer / agentPresets).
import { randomUUID } from 'node:crypto'
import { buildSurfaceSeed, findLastCheckpointSeq, snapTurnEnd } from './surface-seed.js'
import { makeEvent } from './emit.js'
import { deriveEventMessage, foldSurfaceNodes, isCompactCheckpointSource } from './dsh-compat.js'

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
  if (attached) return { header: attached.header, events: [...attached.events], live: true }
  // Optional cold-read backend; absent for many compositions — use ctx.get, not inject.
  const persistence = ctx.get('sessionPersistence')
  if (persistence) {
    const inspected = await persistence.inspect(sessionId)
    return { header: inspected.meta, events: inspected.events, live: false }
  }
  throw new Error(`cannot read session "${sessionId}": not attached and no persistence backend`)
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
// orchestrator
// ---------------------------------------------------------------------------
/**
 * Build a lightweight child session from the last compaction checkpoint to a
 * target turn, then create a new Agent/Session. Throws a classified Error on
 * failure (see `code`), which the route maps to a 4xx/5xx payload.
 */
async function surfaceFork(ctx, { sessionId, messageId, atSeq, increaseTitle = true }) {
  let source = await readSession(ctx, sessionId)
  let events = source.events

  let ckptSeq = findLastCheckpointSeq(events, (data) => isCompactCheckpointSource(data.source))
  if (ckptSeq === undefined) {
    // No checkpoint yet: try to create one on demand so the action is useful
    // even on a session that has not auto-compacted. Best-effort; a busy or
    // too-small session falls through to the clear error below.
    const agent = ctx.agents.get?.(sessionId)
    const compaction = ctx.get('compaction')
    if (agent && compaction?.compactNow) {
      try {
        await compaction.compactNow(agent, new AbortController().signal)
        source = await readSession(ctx, sessionId)
        events = source.events
        ckptSeq = findLastCheckpointSeq(events, (data) => isCompactCheckpointSource(data.source))
      } catch {
        // If compaction is unavailable/busy, keep the clear error below.
      }
    }
    if (ckptSeq === undefined) {
      const err = new Error('该会话尚无压缩点，无法 surface fork：请先让会话继续到触发一次自动压缩后再试')
      err.code = 'no-compaction-checkpoint'
      throw err
    }
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

  const surfaceSeqs = foldSurfaceNodes(events)
  const seed = buildSurfaceSeed(events, {
    surfaceSeqs,
    ckptSeq,
    targetEnd,
    project: deriveEventMessage,
    makeEvent,
  })

  const composition = await composeAgentSetup(ctx, source)
  const childId = `${sessionId}-surface-${randomUUID()}`
  await ctx.agents.create({
    sessionId: childId,
    seed,
    meta: {
      cwd: source.header.cwd,
      parentSession: sessionId,
      seedLength: seed.length,
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
