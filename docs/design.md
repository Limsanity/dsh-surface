# dsh-surface 设计文档

> 状态：**设计定稿，实现进行中**。M1 纯核心已实现并通过单测（6/6）；M2「seed 重播路径」已用**真实 `@deepseek-ai/dsh-session`** 运行期验证（`npm run test:runtime`：重播 seed 通过真实 `Session.create` 严格校验、子会话 `deriveMessages()` 复现父会话压缩后 surface、无 chunk/compaction 标记），并已在**真实 surface-fork 子会话**上核对：seed 无过期 runtime-context / skill-catalog 注入（只出现在子会话自己的 live 轮次、由 loop 重新注入），step/turn 分组正常、无空 context 行（`buildSurfaceSeed` 已改为自然 step 分组 + 剔除瞬态注入 + 工具结果发 `tool/result`）。M2 host 的 ctx 接线（webServer/preset/`ctx.agents.create`）与 M3 client 仍需**真实 dsh 宿主与打包**验证。
> 本插件定位：为 DSH Web GUI 提供一个「**surface fork**」能力——把一段会话从「最近一次 compaction checkpoint」继续到一个目标轮次（target turn）时，用**压缩后的 surface 重播种**出一个轻量新会话，而不是用官方 `fork` 的整段原始日志复制。
> 硬约束：**不修改 `deepseek-harness` 官方 `packages/` 源码**，做成独立 bundle 插件。

---

## 1. 背景与问题

一个会话无限聊下去，存在真实的增长问题（详见 `docs/` 之外的分析）：

- `Session.log` 是 append-only，每个事件被 `deepFreeze` 后永久留在内存里（`@deepseek-ai/dsh-session`）。压缩只是「替换 surface 位置」，**并不删除**被替换的历史事件。
- 每个 `assistant/chunk` 是独立事件：一条长回复会产生成千上万个 chunk 事件，且都留在 `session.events` 里。
- 官方 `SessionStore.fork`（`packages/core/session/src/index.ts:1081`）通过 `_forkSeed` 用 `events.slice(0, boundary + 1)` **整段复制**原始日志，含全部 chunk、全部压缩边界、以及被压缩替换掉的旧历史。所以「fork 后再继续」**并不减重**。

`dsh-surface` 想解决的是：**当用户想「压缩后在新会话继续」时，要的是一个轻量、从最近压缩点开始的子会话，而不是原始 `fork` 的全量副本。**

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| **surface** | 会话的**模型可见消息序列**。`session.surface.nodes` 列出产生消息的事件 seq，`session.deriveMessages()` / `deriveEventMessage` 折叠成 `Message[]`，作为 LLM 请求历史。只有 `user/message`、非空 `assistant/message`、`tool/result` 是 surface；`assistant/chunk`、`turn/step` 边界、`compaction/*` 标记只是 trace/log-only，**不进模型提示**。 |
| **compaction checkpoint** | `compaction-basic` 把头部区间替换成一个 `<compacted-summary>` 格式的 `user/message`（`surfaceOp:{op:'replace'}`）。它是当前 surface 的第一个节点。后续压缩会把这个 checkpoint **合并**进一份新的 consolidated summary，所以 surface 里**至多一个** checkpoint。 |
| **turn / step** | turn = 一轮人机对话（`turn/start`→`turn/end`）；step = turn 内一次模型往返（`step/start`→`step/end`）。只有完整闭合的 `turn/end` 才是可安全快照的分界（`fork` 对 open turn 抛 `OPEN_TURN`）。 |
| **重播种（reseed）** | 用**当前 surface 的模型可见消息**重排出**一段连续、从 0 开始、无 chunk、无悬空引用**的新日志，作为新会话的 seed。区别于 `fork`（原始日志复制）。 |
| **prompt cache** | 按输入 token 前缀匹配的 KV 缓存。压缩把历史替换成 checkpoint（新文本），前缀在 checkpoint 处分叉，因此「压缩本身」会断缓存；**原地压缩与重播种对模型 prompt 而言字节相同**，缓存行为等价；只有不压缩的 `fork` 能保前缀一致。 |

---

## 3. 目标 / 非目标

### 3.1 目标

- 提供 **`@lim324/dsh-surface`** bundle 插件。
- 在 Web UI 提供「surface fork」入口，从**最近一次 compaction boundary** 到**目标 turn** 生成一个轻量子会话。
- 子会话 seed = 压缩后的 surface（checkpoint + 之后到目标 turn 的模型可见消息），**不含 chunk / 被替换历史 / 旧压缩标记**。
- 子会话保持与父会话相同的 agent composition（`agentPreset` / system prompt / tools）。

### 3.2 非目标

- **不改** `deepseek-harness` 官方 `packages/`（不碰 `apiproxy` 的 `RpcMethodMap`、不改 `Session`/`agent-loop`）。
- 不做 durable log 的**物理裁剪/删除**（那是另一套 storage 层原语，见另一份分析）。
- 不做「运行中 step 中途交接」——只做**轮次/空闲边界**上的交接（`fork`/seed 均拒绝 open turn）。
- **不用** raw-slice+rebase（重编号 + 重写 `sourceEventSeqs`/`surfaceOp` 引用）——易错、重复核心不变量。

---

## 4. 方案：surface 重播种

### 4.1 语义

给定源会话 `S`、目标锚点 `atSeq`（可选）：

```
child(新会话) =
   [ request/header(最新) ]
   [ surface(S, 从最近 checkpoint 起到 "目标 turn/end") 的模型可见消息 ]   ← deriveEventMessage 投影后重排
   [ session/end-seed ]
```

### 4.2 与官方 `fork` 对比

| | 官方 `fork` | `dsh-surface` |
|---|---|---|
| seed 来源 | `events.slice(0, boundary+1)`，**全量** | 最近 checkpoint → 目标 turn 的 **surface 投影** |
| 含 chunk | 是 | **否** |
| 含被替换历史 / 旧压缩标记 | 是 | **否** |
| seed 是否连续从 0 | 是（整段） | 是（重排后） |
| 引用是否悬空 | 无（全量都在） | **无**（从 surface 重发，天然自洽） |
| 减重 | 不减 | 明显减重 |
| 边界 | `turn/end` | `turn/end` |
| 缓存 | 保前缀（冷启动少） | 首请求冷（同压缩） |

---

## 5. 总体架构（插件形态，零 core 改动）

参考 `dsh-worktree-panel` 的 bundle 插件形态：

```
dsh-surface/
  package.json             # @lim324/dsh-surface；dsh.bundle.patch + client.inject/platform: web
  cordis.patch.yml         # 需要替换官方组件时用它（非必须，见 §7）
  lib/
    index.js               # host 半：webServer 端点 + 重播种逻辑
    client.js              # client 半：槽位按钮 + 调端点 + open(childId)
  docs/
    design.md              # 本文档
```

**数据流**：

```
[Web UI] surface 按钮
   └─(client) fetch POST /api/dsh-surface/fork { sessionId, atSeq? }
           └─(host) 读会话 → 找最近 checkpoint → 吸附目标 turn
                   → deriveSurface 构建 seed → 取 composition
                   → ctx.agents.create({ seed, meta.parentSession, ... })
                   → 返回 childId
           ▲ childId
[Web UI] ctx.sessions.open(childId)
```

---

## 6. Host 半（lib/index.js）

### 6.1 注入

```ts
const inject = [
  'webServer',        // 承载自定义 HTTP 端点
  'sessions',         // ctx.sessions.get / readFrom / inspect
  'agents',           // ctx.agents.create
  'sessionQuery',     // 解析 composition / agentPreset
  'systemPrompt',     // 复刻 composition 所需
  'compaction',       // 可选：无 checkpoint 时先 compactNow()
  'tools',
]
```

### 6.2 端点契约

`POST /api/dsh-surface/fork`

```ts
type Request = {
  sessionId: SessionId
  atSeq?: number        // 目标锚点；省略 = 最近已完成 turn/end
  increaseTitle?: boolean
}
type Response = { ok: true; childId: SessionId } | { ok: false; code: string; message: string }
```

错误码（建议）：`session-not-found` / `no-compaction-checkpoint` / `open-turn` / `composition-unresolved` / `internal`。

### 6.3 算法（重播种核心）

1. **读会话**：`ctx.sessions.get(sessionId)`（live）等价于拿到 `Session`（有 `.surface`）；cold 用 `sessionQuery`/persistence `inspect` 或 `readFrom` 得到 `{ header, events }`。
2. **找最近 checkpoint**：在 `events` 中定位最后一个满足 `isCompactCheckpointSource(ev)`（`@deepseek-ai/dsh-compaction` 公开导出）的 `user/message`，记为 `ckptSeq`。没有 → 按配置降级（§9）。
3. **吸附目标 turn**：复用官方 fork 的 snap 规则（`packages/host/apiproxy/src/api-proxy.ts:2263`）：`atSeq` 给定时取「第一个 `turn/end` ≥ atSeq」；省略/超尾取「最后一个 `turn/end`」。若落在 open turn 内，落到最后一个已完成 `turn/end`。
4. **构建 seed（deriveSurface）**：
   - 用 `foldSurface(events)`（`@deepseek-ai/dsh-session` 公开导出）折出 `surface.nodes`。
   - 取 `ckptSeq` 起到目标 `turn/end` 的 surface 节点，逐个 `deriveEventMessage(events[seq])` 投影成 `Message[]`。
   - **剔除瞬态注入**：跳过 `source.kind === 'skill-catalog'` 与 `source.kind==='plugin' && source.plugin==='@deepseek-ai/dsh-system-prompt'` 的 user 消息（运行期上下文快照、可用技能目录）。这些由新会话自己在下一步重新注入，保留旧快照只会带进过时上下文。
   - **按自然 step/turn 重排**：一个 `step` = 进入的 user 消息（连续 user/注入 context 归并）+ 一条 assistant + 其工具结果。工具结果（`source.kind==='tool'` 或 content 含 `tool-result`）**发成 `tool/result` 事件**；带 tool-call 的 assistant 保持该 step 打开以接收工具结果；其后的 continuation assistant 在**同一 turn** 开新 step；无 tool-call 的 assistant 收尾该 step 与 turn。seq 从 0 连续。
   - 得到一段**连续、从 0 起、balanced、无 chunk、无悬空引用、step/turn 合理分组、无瞬态注入**的 `SessionEvent[]`。
5. **取 composition**：解出父会话的 `agentPreset` 与其 `setup`（`sessionQuery` → `resolveSessionPreset`；再 `composeAgent(preset)`）。这步必须与 api-proxy 的 fork 路径保持一致，否则子会话会用不同的工具/提示词重放。
6. **创建子会话**：
   ```ts
   ctx.agents.create({
     sessionId: childId,
     seed,                                     // 步骤 4
     meta: { cwd, parentSession: sessionId, seedLength: seed.length, agentPreset },
     agentOptions,                             // 继承父会话的 provider/model 等
     setup,                                    // 步骤 5
   })
   ```
7. 返回 `childId`。

### 6.4 为什么要「deriveSurface」而不是「raw-slice + rebase」

`fork` 的 `_forkSeed` 直接 `events.slice` 会连 chunk、被替换历史、旧压缩标记一起复制。若改成「从 checkpoint 起 slice 后 rebase」，必须**平移并重写**切片内所有 `sourceEventSeqs`、`surfaceOp.replace.start/end`、`compaction.shadowedSeqs`；且 checkpoint 的 `surfaceOp.replace` 引用被丢弃的旧 seq，需把它改成 `append` 并去掉指向已删内容的 provenance。这等于在插件里**重写核心折叠/溯源不变量**，极易错。

本方案（deriveSurface）从**当前 surface 的投影结果**重发消息，天然得到干净、连续、无悬空引用的 seed，`Session` 的 seed 校验（`seq === index`、引用存在）可直接通过。**刻意选择「从 surface 重建一份干净 seed」，而不是 raw-slice + rebase。**

一个**有意为之的偏差**：子会话的模型可见 surface **不**等于父会话压缩后 surface 的逐字节拷贝——`buildSurfaceSeed` 会**剔除瞬态注入**（runtime-context 快照、skill-catalog），因为新会话会在下一步由 `RuntimeContextProjection` 重新注入新鲜上下文；同时把 tool 结果发成正确的 `tool/result`、并按自然 step/turn 分组。这样子会话上下文更干净、无过期注入、轨迹无空行，但「模型可见」部分去掉了这些瞬态项（它们由新会话自己补回）。

---

## 7. Client 半（lib/client.js）

### 7.1 渲染位置

- 首选槽位：**`conversation.chat.assistant-actions`**（`packages/client/ui-conversation/src/client/contract/slots.ts:148`，每条 finalized assistant 消息的动作条）。用 `ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ ... }))` 注册。
- 可选：会话 header 动作槽位 `conversation.session.header.actions`。
- 若需要按钮**精确嵌入 `MessageIconActions` 那行**（branch 图标旁），用 `cordis.patch.yml` 禁用官方组件、插入一个由它 fork 出来的增强版（worktree-panel 手法）。这是「插件」，不改官方源码。

### 7.2 交互

```ts
onSurface = (seq) => {
  fetch('/api/dsh-surface/fork', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, atSeq: seq, increaseTitle: true }),
  }).then(r => r.json()).then(res => {
    if (res.ok) ctx.sessions.open(res.childId)
    else /* 展示错误（如 no-compaction-checkpoint） */
  })
}
```

- 成功后 `ctx.sessions.open(childId)`，让子会话进入视野。
- 标题可用 `increaseTitle: true` 增加尾缀（对标官方 fork）。

---

## 8. 边界与门控（设计决策点）

| 场景 | 建议行为 |
|---|---|
| **无 checkpoint** | 默认：端点返回 `no-compaction-checkpoint`，按钮显示「尚未压缩」。可配 `fallbackToForkOnNoCheckpoint` 退化到 `ctx.sessions.fork`。 |
| **open turn（在目标之后有未闭合轮次）** | 吸附到最后一个已完成 `turn/end`（同 fork 规则）。 |
| **cold 会话** | 从 events 重建 surface，逻辑不变。 |
| **composition 解析失败** | 返回 `composition-unresolved`；不要在缺少 setup/preset 时创建子会话（否则会用错工具/提示词重放）。 |
| **checkpoint 在目标 turn 之后** | 说明目标点早于最近压缩点，属异常输入 → 返回错误，或取目标 turn 之前最近 checkpoint。 |
| **目标 turn 早于 checkpoint** | 保持「checkpoint 起」为 seed 下界；目标 turn 不能早于 checkpoint。 |

---

## 9. 配置（Config）

```ts
interface SurfaceConfig {
  /** 端点路径前缀，默认 /api/dsh-surface。 */
  endpointPath?: string        // default '/api/dsh-surface'
  /** 子会话标题是否递增尾缀。 */
  increaseTitle?: boolean      // default true
  /** 无 checkpoint 时退化为官方 fork。 */
  fallbackToForkOnNoCheckpoint?: boolean  // default false
  /** 无 checkpoint 且此开关开启时，先 compactNow() 再取。 */
  autoCompactWhenNeeded?: boolean         // default false
}
```

不做「钩进官方 `cordis.yml` 才生效」的隐式行为；配置字段均为显式、可验证。

---

## 10. Prompt cache 影响（明确交代）

- **压缩本身已断缓存**：checkpoint 是新文本，前缀在 checkpoint 处分叉。
- **重播种与原地压缩等价**：二者对模型可见 prompt 字节相同，首请求都冷，之后各自重建 warm cache。
- **只有不压缩的 `fork` 能保前缀一致**（但重且不轻量）。
- `dsh-surface` 不因此额外破坏缓存——它只是用了压缩后已经发生的那次断缓存。

---

## 11. 风险 / 限制

1. **composition 复刻**：子会话必须与父会话同 preset/system prompt/tools，否则会重放模型无法执行的调用。最易出错，需单独验证。
2. **seed 正确性**：`Session` 校验很严（连续、从 0、无悬空引用）；做错即失败（响亮报错，不会静默出错）。坚持 deriveSurface 以规避。
3. **UI 位置**：若必须嵌进 `MessageIconActions` 那行，需 patch-layer fork 组件（额外构建复杂度）。
4. **client open 路由**：`ctx.sessions.open(childId)` 需子会话已进入 workspace/列表，否则用户看不到新会话。
5. **无 checkpoint 的 UX**：未压缩时按钮不可用/降级，需在产品层明确提示。

---

## 12. 测试与验证

- **单测（host 核心，纯函数）**：`deriveSurfaceSeed(events, ckptSeq, targetTurnEnd)` —— 断言输出连续、从 0、balanced、无 chunk、无悬空引用；checkpoint 定位；turn 吸附（含 open turn、超尾、早于 checkpoint）。
- **host 集成**：构造含一次 compaction 的会话，调端点断言返回 childId 且子会话 surface 与父会话压缩后一致。
- **client**：槽位渲染出按钮；点击触发端点；成功后调用 `open(childId)`；错误展示。
- **手动 e2e**：在 Web UI 里做一次压缩后「surface fork」，确认子会话上下文 = checkpoint + 目标 turn 消息，且能继续对话。

---

## 13. 里程碑

- **M1**：host 侧纯函数 `deriveSurfaceSeed`（`buildSurfaceSeed` 自然 step/turn 分组 + 剔除瞬态注入 + 工具结果发 `tool/result`）+ 单测（6/6，不碰 Web）。✅
- **M2**：host 端点 + `ctx.agents.create` + composition 解析 + 集成测试。seed 重播路径已运行期验证；端点/`ctx.agents.create`/preset 需真实宿主。⏳
- **M3**：client 槽位按钮 + 端点调用 + `open(childId)`。骨架已装、槽位渲染已验证；端到端待实测。⏳
- **M4**：配置项 + 门控（无 checkpoint / 降级 / autoCompact）。无 checkpoint 时已「现场 `compactNow` + 清晰报错」部分落地；`fallbackToForkOnNoCheckpoint`/`autoCompactWhenNeeded` 待接线。⏳
- **M5**：打包（`lib/build.mjs`）+ `cordis.patch.yml`（如需换组件）+ 发版。`build.mjs` + profile 安装 done。✅

---

## 14. 开放问题（待确认）

1. **按钮位置**：每条消息动作条（`conversation.chat.assistant-actions`），还是会话 header 动作？是否必须精确嵌进 branch 那行（决定是否用 patch-layer）？
2. **无 checkpoint 行为**：置灰 / 报错 / 退化 `fork` / 先 `compactNow()`？
3. **目标 turn 语义**：per-message（吸附到该消息所在 turn/end），还是「当前末尾」？
4. **composition 来源**：`sessionQuery` + `resolveSessionPreset` + `composeAgent` 是否为插件可注入的公开能力，还是需在 host 侧复刻一段（若属 `apiproxy` 内部助手，需确认）。

---

## 15. 参考（代码锚点）

- `packages/core/session/src/index.ts` — `Session.log`、`deriveMessages()`、`SessionStore.fork`/`_forkSeed`（`events.slice(0,boundary+1)`）、`OPEN_TURN`。
- `packages/core/session/src/surface.ts` — `deriveEventMessage`、`foldSurface`、`surface.nodes`、`isCompactCheckpointSource`（同包/compaction 导出）。
- `packages/compaction/compaction-basic/src/region.ts` — `commitCompactionBody`（checkpoint `surfaceOp.replace` + `shadowedSeqs`）。
- `packages/host/apiproxy/src/api-proxy.ts:2263` — fork 的 `atSeq` snap 规则；`:1611` `ctx.agents.create({ seed?, meta, setup })`。
- `packages/core/agent/src/index.ts:80` — `CreateAgentOptions`（`seed`/`meta.parentSession`/`agentPreset`）。
- `packages/client/ui-conversation/src/client/contract/slots.ts:148` — `conversation.chat.assistant-actions` 槽位。
- `dsh-worktree-panel/`（group 内范本）— `cordis.patch.yml` + client/client.js + host/index.js + `webServer` 端点。
