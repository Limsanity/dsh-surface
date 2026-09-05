# @lim324/dsh-surface

[English](README.md) | 中文

一个独立的 DSH Web GUI bundle 插件，提供 **surface fork** 动作：把一段会话**从最近一次 compaction checkpoint 继续到一个目标轮次**，生成为一个**轻量新会话**（surface 重播种），而不是官方 `fork` 那种整段原始日志复制。

无需改动 `deepseek-harness` 的 `packages/` 源码。

## 功能

当一个会话被 auto-compact 后，它的模型可见 **surface** 已经很小：一个 `<compacted-summary>` checkpoint，加上保留的最近若干轮。`dsh-surface` 把这段 surface（checkpoint + 最近消息）重新投影成一段干净、连续、balanced 的 seed，并据此创建一个新的 Agent/Session。

这个 child 只带走压缩后的上下文——**没有 `assistant/chunk` 事件、没有被替换的压缩前历史、没有旧的 `compaction/*` 标记**——所以比原始 `fork` 小得多，而模型看到的仍是同一段压缩后的对话。

> **不是原始 `fork`。** 官方的 `SessionStore.fork` 复制 `events.slice(0, boundary+1)`（整份日志，含每个 chunk 和所有被替换历史）。`dsh-surface` 通过 `deriveEventMessage` 投影当前 surface。

## 架构

```
[Web UI] "surface" 动作（assistant-actions 槽位）
   └─(client) POST /api/dsh-surface/fork { sessionId, messageId? }
           └─(host) 读会话 → 定位最近 compaction checkpoint
                   → 吸附目标 turn/end（messageId / atSeq / 当前末尾）
                   → deriveSurface seed（无 chunk、无被替换历史；自然 step/turn 分组；剔除瞬态注入）
                   → 组合 preset → ctx.agents.create({ seed, meta.parentSession, ... })
                   → { childId }
[Web UI] ctx.sessions.open(childId)
```

| 文件 | 作用 |
|---|---|
| `lib/surface-seed.js` | **纯核心**（零 DSH 依赖）：checkpoint 定位、turn 吸附、seed 重排。有单测。 |
| `lib/index.js` | **Host**：`webServer` 路由、真实 `@deepseek-ai/dsh-compaction` import（由 `scripts/link-dev-deps.sh` 解析到 HOST 拷贝）、`ctx.agents.create`。 |
| `lib/client.js` | **Client**：assistant-actions 槽位按钮 → 调端点 → `open(childId)`。 |
| `cordis.patch.yml` | Bundle 清单：把插件插入 web app。 |

## 配置

```ts
interface SurfaceConfig {
  enabled?: boolean        // 默认 true
  endpointPath?: string    // 默认 '/api/dsh-surface'
}
```

## 端点

`POST /api/dsh-surface/fork`

```ts
// 请求
{ sessionId: string; messageId?: string; atSeq?: number; increaseTitle?: boolean }
// 响应（成功）
{ ok: true; childId: string; seedLength: number; ckptSeq: number; targetEnd: number }
// 响应（错误）
{ ok: false; code: 'no-compaction-checkpoint' | 'message-not-found' | 'no-target-turn' | 'internal'; message: string }
```

- `messageId` → 该 `assistant/message` 所在的已完成轮。
- `atSeq` → 向上吸附到其后的第一个 `turn/end`（与官方 fork 规则一致）。
- 都不给 → 最后一个已完成 `turn/end`。

## 实现状态

| 里程碑 | 状态 |
|---|---|
| M1 纯核心（`findLastCheckpointSeq` / `snapTurnEnd` / `buildSurfaceSeed`） | ✅ 已实现 + 单测（`node --test test/surface-seed.test.js`，6/6 通过） |
| M2 seed 路径对照**真实** `@deepseek-ai/dsh-session` | ✅ 运行期验证（`npm run test:runtime`）：重排 seed 通过真实 `Session.create`，并精确复现压缩后 surface，无 chunk/compaction 泄漏 |
| M2 host 路由 + `ctx.agents.create` + preset 组合 | ⏳ 参考实现——需在**真实 dsh host** 上验证（webServer 路由、`presets.mount`、`ctx.agents.create`） |
| M3 client 槽位按钮 + 端点 + `open(childId)` | ⏳ 参考骨架（需打包 + 运行期验证） |
| M4 配置 + 门控（无 checkpoint / fallback / autoCompact） | ⏳ fallback/autoCompact 待接线 |
| M5 打包（`lib/build.mjs`）+ 装进 profile | ✅ `build.mjs` 已加；已通过 `dsh plugin add` 装进 `web` profile |

## 已验证事实

- `test/surface-seed.test.js`（纯、独立）：checkpoint 定位、atSeq/省略 turn 吸附、从 surface 连续重排、无 chunk/被替换历史。`buildSurfaceSeed` 会把消息按**自然 step** 分组（进入的 user 消息 + 一条 assistant + 其工具结果在一个 step；带 tool-call 的 assistant 保持该 step 打开以接收 `tool/result`；其后的 continuation assistant 在同一 turn 开新 step），并**剔除瞬态逐 step 注入**（`@deepseek-ai/dsh-system-prompt` 运行期上下文快照与 `skill-catalog`），这些由新会话自己重新生成。
- `test/runtime-validation.mjs`（真实 DSH，不改 harness 源码）：构造一个含 compaction checkpoint 的真实源 `Session`，然后验证 host 路径：
  - 用 live `Session` 的 `session.surface.nodes` + `session.deriveEventMessage` 生成 surface/投影（同 `lib/index.js`），压缩点检测与真实 `@deepseek-ai/dsh-compaction` 的 `isCompactCheckpointSource` 语义一致；
  - 重排出的子会话 seed 通过**真实严格的 `Session.create`** 校验，
  - 复现与压缩后源会话相同的模型可见 `deriveMessages()`，
  - 不带 `assistant/chunk`、不带 `compaction/*`，seq 从 0 连续。

- 从一个真实 surface-fork 子会话（`session-…-surface-35695bca…`）的 `session.jsonl.zstd` 核对：seed 部分**没有过期的 runtime-context / skill-catalog 注入**（这些只出现在子会话自己的 live 轮次、由它的 loop 重新注入），step/turn 分组干净——user 提示 + assistant + `tool/result` 在一个 step、continuation 在新 step，无空 "context" 行。

### host 用 `link-dev-deps` 解析 `@deepseek-ai/dsh-*`

`link:` 安装的插件 host **无法按名字解析裸 `@deepseek-ai/dsh-*` 导入**——Node 会沿符号链接解析到真实 checkout 目录、错过 DSH 的平铺回退目录，而且 registry 上 `@deepseek-ai/*` 的版本与 harness 不一致（如 `@deepseek-ai/dsh-session` 只发布到 `0.0.1-rc.1`，harness 用 `0.1.1-rc.2`）。所以 `scripts/link-dev-deps.sh` 会把 **HOST 拷贝**的 `@deepseek-ai/*` 软链进本 checkout 的 `node_modules`（`pnpm install` 后运行）。`lib/index.js` 因此可以直接 **import 真实 `@deepseek-ai/dsh-compaction` 的 `isCompactCheckpointSource`**，不再复刻 dsh 内部。surface 折叠/投影仍用 **live `Session` 自带 API**——`session.surface.nodes`（surface）与 `session.deriveEventMessage(event)`（投影）。因为需要 live `Session`，**未加载(冷)会话无法 surface-fork**——先在 Web UI 打开。client 半用 `ctx.*` 服务 + 模块表的 `require('react')`。

### 已验证 vs 未验证

算法、`makeEvent`、真实 `Session` 接受性已验证；host 用 live `Session` API，压缩点语义与真实 `@deepseek-ai/dsh-compaction` 一致。仍需**真实 dsh host** 实测（此处未覆盖）：`webServer` 路由、`ctx.sessionPersistence` 冷读、`ctx.get('agentPresets')` 组合、以及 `ctx.agents.create` 端到端。

## 已知待办

- **Host 运行期验证**：`ctx.get('agentPresets')` 组合（`presets.resolve`/`presets.mount`）与 `ctx.agents.create({ seed })` 路径需在真实 dsh host 上实测。未复刻 `installModelSelection` 的逐 agent 钩子。
- **Client 打包**：`lib/client.js` 需要 `lib/build.mjs`（打包 + 槽位类型）以及四股 props 纪律在真实槽位系统下核验。
- **seed 不带 `request/header`**（有意为之）：child 是新会话，会自己记录 header。
- **drop/fallback**：`fallbackToForkOnNoCheckpoint` 与 `autoCompactWhenNeeded` 已在 `docs/design.md` 说明，但尚未接线。

## 安装

`lib/index.js` 里的 `@deepseek-ai/dsh-*` 导入（`@deepseek-ai/dsh-compaction`）在加载时通过 `scripts/link-dev-deps.sh` 解析到 **HOST 拷贝**——它把 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 软链进本 checkout 的 `node_modules`。任何 `pnpm install` 后都要重跑。无论哪种安装方式，装完都重启 `dsh web`。

### 从 npm（推荐）

```bash
dsh plugin --profile web add @lim324/dsh-surface
# 锁定版本
dsh plugin --profile web add @lim324/dsh-surface@0.1.0
```

### 从 GitHub

```bash
# 简写（默认分支）
dsh plugin --profile web add github:Limsanity/dsh-surface
# 或显式 git URL
dsh plugin --profile web add git+https://github.com/Limsanity/dsh-surface.git
```

client bundle（`lib/client.js`）已入库，所以 git 安装无需 build。

### 本地开发（link）

```bash
npm run build               # 从 src/client.js 重新生成 lib/client.js（仅当 src/client.js 改动时）
./scripts/link-dev-deps.sh  # 把 HOST 的 @deepseek-ai/* 软链进 node_modules（host import 需要）
dsh plugin --profile web add link:/绝对路径/到/dsh-surface
```

link 安装的插件 host 无法按名字解析裸 `@deepseek-ai/dsh-*` 导入，所以 `scripts/link-dev-deps.sh` 会把 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 软链进本 checkout 的 `node_modules`，让 `lib/index.js` 从 **HOST 拷贝** import 真实的 `@deepseek-ai/dsh-compaction`。任何 `pnpm install` 后都要重跑。此步骤仅用于**本地 link 开发**——npm/git 安装（真实包）会在加载时经平铺回退目录直接在 host 上解析该 import。

三种方式都会在 `~/.dsh/profiles/web` 里跑 `pnpm add`，同时把 `@lim324/dsh-surface` 写入 profile 的 `dependencies` 和 `dsh.profile.bundles`。

## 相关文档

- [`docs/design.md`](docs/design.md) — 完整设计（目标、非目标、算法、门控、风险、里程碑）。
