# @lim324/dsh-surface

English | [中文](README.zh.md)

A standalone DSH Web GUI bundle plugin that adds a **surface fork** action: continue a session in a **lightweight new session** seeded from the **last compaction checkpoint** to a target turn (surface re-seed), instead of the official `fork`'s full raw-log copy.

No change to `deepseek-harness` `packages/` source is required.

## What it does

When a session has been auto-compacted, its model-visible **surface** is already small: a single `<compacted-summary>` checkpoint followed by the retained recent turns. `dsh-surface` re-emits that surface (checkpoint + recent messages) as a clean, contiguous, balanced seed and creates a new Agent/Session from it.

That child brings only the compressed context — **no `assistant/chunk` events, no shadowed pre-compaction history, no old `compaction/*` markers** — so it is much smaller than a raw `fork` while the model sees the same compacted conversation.

> **Not a raw `fork`.** The official `SessionStore.fork` copies `events.slice(0, boundary+1)` (whole log, incl. every chunk and all shadowed history). `dsh-surface` projects the current surface via `deriveEventMessage` instead.

## Architecture

```
[Web UI] "surface" action (assistant-actions slot)
   └─(client) POST /api/dsh-surface/fork { sessionId, messageId? }
           └─(host) read session → find last compaction checkpoint
                   → snap target turn/end (messageId / atSeq / current end)
                   → deriveSurface seed (no chunks, no shadowed history; natural step/turn grouping; transient injections dropped)
                   → compose preset → ctx.agents.create({ seed, meta.parentSession, ... })
                   → { childId }
[Web UI] ctx.sessions.open(childId)
```

| File | Role |
|---|---|
| `lib/surface-seed.js` | **Pure core** (zero DSH imports): checkpoint locate, turn snap, seed re-emission. Unit-tested. |
| `lib/index.js` | **Host**: `webServer` route, real `@deepseek-ai/dsh-compaction` import (resolved to the HOST copy by `scripts/link-dev-deps.sh`), `ctx.agents.create`. |
| `lib/client.js` | **Client**: assistant-actions slot button → endpoint → `open(childId)`. |
| `cordis.patch.yml` | Bundle manifest: insert the plugin into the web app. |

## Config

```ts
interface SurfaceConfig {
  enabled?: boolean        // default true
  endpointPath?: string    // default '/api/dsh-surface'
}
```

## Endpoint

`POST /api/dsh-surface/fork`

```ts
// request
{ sessionId: string; messageId?: string; atSeq?: number; increaseTitle?: boolean }
// response (ok)
{ ok: true; childId: string; seedLength: number; ckptSeq: number; targetEnd: number }
// response (error)
{ ok: false; code: 'no-compaction-checkpoint' | 'message-not-found' | 'no-target-turn' | 'internal'; message: string }
```

- `messageId` → the completed turn containing that `assistant/message`.
- `atSeq` → snapped up to the first `turn/end` at/after it (mirrors the official fork rule).
- neither → the last completed `turn/end`.

## Implementation status

| Milestone | Status |
|---|---|
| M1 pure core (`findLastCheckpointSeq` / `snapTurnEnd` / `buildSurfaceSeed`) | ✅ implemented + tested (`node --test test/surface-seed.test.js`, 6/6 pass) |
| M2 seed path against **real** `@deepseek-ai/dsh-session` | ✅ runtime-validated (`npm run test:runtime`): the re-emitted seed passes real `Session.create` and reproduces the post-compaction surface exactly, with no chunk/compaction leakage |
| M2 host route + `ctx.agents.create` + preset compose | ⏳ reference code — needs verification against a **live dsh host** (webServer route, `presets.mount`, `ctx.agents.create`) |
| M3 client slot button + endpoint + `open(childId)` | ⏳ reference skeleton (needs bundling + runtime verification) |
| M4 config + gating (no checkpoint / fallback / autoCompact) | ⏳ fallback/autoCompact pending |
| M5 packaging (`lib/build.mjs`) + profile install | ✅ `build.mjs` added; installed into `web` profile via `dsh plugin add` |

## Verified facts

- `test/surface-seed.test.js` (pure, standalone): checkpoint locate, atSeq/omitted turn snap, contiguous re-emission from surface without chunks/shadowed history. `buildSurfaceSeed` groups messages into **natural steps** (entered user messages + one assistant + its tool results in one step; a tool-call assistant keeps its step open to receive `tool/result` events; the continuation assistant opens a new step in the same turn) and **drops transient per-step injections** (runtime-context snapshot `@deepseek-ai/dsh-system-prompt` and `skill-catalog`) that a fresh session re-derives itself.
- `test/runtime-validation.mjs` (real DSH, no harness source edits): builds a real source `Session` containing a compaction checkpoint, then validates the **host path** against it — using the LIVE session's own API (`session.surface.nodes` + `session.deriveEventMessage`) exactly as `lib/index.js` does:
  - the re-emitted child seed passes the **real strict `Session.create`** validator,
  - reconstructs the same model-visible `deriveMessages()` as the post-compaction source,
  - carries no `assistant/chunk` and no `compaction/*` events, is seq-contiguous from 0.

- A real surface-forked child session (`session-…-surface-35695bca…`) was inspected from its `session.jsonl.zstd`: the seed portion has **no stale runtime-context / skill-catalog injection** (those appear only in the child's own live turn, freshly injected by its loop) and clean step/turn grouping — user prompt + assistant + `tool/result` in one step, continuation assistants in new steps, no empty "context" rows.

### Live-session host (`link-dev-deps` resolves `@deepseek-ai/dsh-*`)

A link-installed plugin's host **cannot resolve bare `@deepseek-ai/dsh-*` imports** by name — only real npm packages get a `.pnpm` store, and the registry's `@deepseek-ai/*` versions don't match the harness's (e.g. `@deepseek-ai/dsh-session` is published at `0.0.1-rc.1`, the harness uses `0.1.1-rc.2`). So `scripts/link-dev-deps.sh` symlinks the **HOST copies** of those packages into this checkout's `node_modules` (run after `pnpm install`). `lib/index.js` therefore imports the REAL `isCompactCheckpointSource` from `@deepseek-ai/dsh-compaction` instead of mirroring dsh internals. The surface fold/projection still uses the **live `Session`'s own API** — `session.surface.nodes` for the surface and `session.deriveEventMessage(event)` for the projection — and consumes sessions / agents / webServer / agentPresets through injected `ctx` services. Because it needs the live `Session`, a **cold (unloaded) session cannot be surface-forked** — open it in the Web UI first. The client half uses `ctx.*` services and the module table's `require('react')`.

### What is verified vs. unverified

The algorithm, `makeEvent`, and real-`Session` acceptance are validated via the live-Session API path. Still needing a **live dsh host** to exercise (not covered here): `webServer` routing, the `ctx.get('agentPresets')` composition, and `ctx.agents.create` end-to-end.

## Known follow-ups

- **Host runtime validation**: the `ctx.get('agentPresets')` composition (`presets.resolve`/`presets.mount`) and `ctx.agents.create({ seed })` path must be exercised against a real dsh host. `installModelSelection` per-agent hooking is not replicated here.
- **Client bundling**: `lib/client.js` needs `lib/build.mjs` (bundle + slot typing) and the four-props share discipline verified against the live slot system.
- **No request/header** is carried in the seed (deliberate): the child is a fresh session and logs its own header.
- **drop/fallback**: `fallbackToForkOnNoCheckpoint` and `autoCompactWhenNeeded` are documented in `docs/design.md` but not yet wired.

## Install

The `@deepseek-ai/dsh-*` import in `lib/index.js` (`@deepseek-ai/dsh-compaction`) resolves at load time to the **HOST copy** via `scripts/link-dev-deps.sh`, which symlinks `$DSH_HOME/profiles/node_modules/@deepseek-ai` into this checkout's `node_modules`. Run it after any `pnpm install`. Whichever way you install, restart `dsh web` after adding.

### From npm (recommended)

```bash
dsh plugin --profile web add @lim324/dsh-surface
# pin a version
dsh plugin --profile web add @lim324/dsh-surface@0.1.0
```

### From GitHub

```bash
# shorthand (default branch)
dsh plugin --profile web add github:Limsanity/dsh-surface
# or explicit git URL
dsh plugin --profile web add git+https://github.com/Limsanity/dsh-surface.git
```

The client bundle (`lib/client.js`) is committed to the repo, so a git install needs no build step.

### Local dev (link)

```bash
npm run build               # regenerate lib/client.js from src/client.js (only when src/client.js changes)
./scripts/link-dev-deps.sh  # symlink the HOST's @deepseek-ai/* into node_modules (required for the host import)
dsh plugin --profile web add link:/绝对路径/到/dsh-surface
```

A link-installed plugin's host **cannot resolve bare `@deepseek-ai/dsh-*` imports by name** (Node follows the symlink to the real checkout dir, past DSH's flat fallback). So `scripts/link-dev-deps.sh` symlinks `$DSH_HOME/profiles/node_modules/@deepseek-ai` into this checkout's `node_modules`, letting `lib/index.js` import the real `@deepseek-ai/dsh-compaction` from the **HOST copy**. Re-run it after any `pnpm install`. This step is only needed for **local link** development — an npm/git install (a real package) resolves the import against the host at load time via the flat fallback.

All three forms run `pnpm add` in `~/.dsh/profiles/web`, adding `@lim324/dsh-surface` to both the profile's `dependencies` and `dsh.profile.bundles`.

## See also

- [`docs/design.md`](docs/design.md) — full design (targets, non-goals, algorithm, gating, risks, milestones).
