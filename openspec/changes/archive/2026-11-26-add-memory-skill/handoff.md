# Handoff: MVP5 记忆与技能 `add-memory-skill`

- Change: `add-memory-skill`
- 阶段：MVP5，MVP4 之后、MVP6 之前
- 时间：1–2 周
- 状态：**已通过维护者最终审计并归档推送**（2026-11-26 18:34，维护者确认“通过，归档并推送”）
- 依据：`~/workspace/personal-agent-mvp1-upgrade-roadmap.md`（2026-11-26 新版）MVP5 节

## 核对记录（2026-11-26 17:57，Muse 核对 GitHub `origin/main`）

- 最新 HEAD：`3912d66` — `add-readonly-patrol: 实现 MVP4 只读巡检、工具层白名单拦截、最小适配器与三档分流`
- MVP4 已完成并归档推送，内容与本包的 proposal 一致：
  - 只读巡检控制面：`PatrolEngine` 防重叠跳过与运行时限、工具层 `PatrolPermissionGuard` 按巡检 Mandate 纯读白名单拦截写 / 发消息 / 付款 / 控浏览器
  - 库存与新订单最小 Ontology 规范字段适配器与 4 类桩接口（价格、物流、供应商回复、爆品信号只留接口）
  - 三档分流与每日一次日报、大问题带证据升级 MVP2a TicketEngine + MVP2b ApprovalEngine
  - 小模型巡检 / 异常大模型复核 / 增量摘要缓存与独立巡检 token 账本
  - 文件：`server/patrol/adapters.ts`、`engine.ts`、`fixtures.ts`、`host.ts`、`patrol.test.ts`、`store.ts`、`server/routes/patrol.ts`、`shared/patrol.ts`；`openspec/changes/archive/2026-11-26-add-readonly-patrol/`；`openspec/specs/patrol/spec.md`
- 验证记录（见该提交的 WORKSPACE.md 记录）：`Vitest` 35/35、`tsc`、oxlint、隔离端到端 7/7 及 `openspec validate --all --strict` 全通过，经维护者确认归档并推送 `origin/main`。此前总数 24/24，MVP4 新增 11 项，35/35 对得上。
- **结论：没问题，可以开 MVP5。**
- **未阻塞 MVP5，但要记下来**：
  - 本次核对的 commit 页面只显示了前 369 行（主要是 `design.md` 的 diff），handoff.md 的完整验证数字没在页面上展开，上面引用的 35/35、7/7、validate 全通过来自该提交里 `WORKSPACE.md` 的归档记录，不是逐行读到的 handoff 原文。如果本地 agent 的 handoff 里数字不一致，以本地 handoff 为准。
  - design.md 里有一处小瑕疵：第 4 节待核对清单里“库存和新订单的假数据”几个字在提交里显示成了乱码（`库存��新订单`），不影响代码，但下次归档前最好修一下，避免文档里留乱码。
  - MVP1 仍有两项待验收：另一个白名单外账号、整机断网恢复（`lark-cli` 同凭据竞争消费者未清除，全断网恢复验收仍待做）。
  - 飞书群消息接收权限：MVP3 handoff 里写的是“开放平台开启群消息接收权限后直连”，真实群聊 @ 测试还没做，MVP3 的 7/7 是隔离环境跑的。
  - 服务端集成测试受 `listen EPERM` 阻塞，未误标完整回归通过。
  - 自建业务系统完整出口凭据注入，另开 `add-credential-proxy`，不在 MVP2b / MVP3 / MVP4 里做。

## 已确认的基线

- 代码基线：`5987204e3`
- 工作基线：`92eb6457ff128d4bbbd622ab9e4b42da4200f473`
- 最新 HEAD：`3912d66`（2026-11-26）
- 本地路径：`/Users/latiao/OpenMausBot`
- 远程仓库：https://github.com/latiao-ai/personal-agent
- MVP0：已跑通，等 `bootstrap-dev-workspace` 最终审计。
- MVP1：已到 R2 收尾，剩下另一个白名单外账号验收、整机断网恢复验收、维护者最终审计。
- MVP1.5：已批 R1，2026-11-26 15:20，已归档推送 `2a15dc0`。
- MVP2a：已完成并归档推送 `7d978df`。
- MVP2b：已完成并归档推送 `786516d`。
- MVP3：已完成并归档推送 `19fb7db`。
- MVP4：已完成并归档推送 `3912d66`。

## 复用盘点（第 0 步，2026-11-26 本地核对完成）

| 模块 / 能力 | 状态 | 现有路径与真实入口 | MVP5 处置（已有 / 要改 / 要新建） |
|---|---|---|---|
| 每晚复盘 | 已有 | `server/memory-dream.ts`（`dreamConversations`、`dreamPrompt`、`DREAM_MARKER` 等） | **复用 + 扩展封装**：不破坏原文件；在新建控制面引擎 `server/memory-skill/` 中复用 `memory-dream.ts` 的无工具只读提炼理念，实现只写记忆、不执行/不花钱/不发消息的每晚复盘与独立 token 记账 |
| 记忆读写存储 | 已有 | `server/memory-store.ts`（`parseMemoryPath`、`resolveMemoryPath`、`hashMemoryText`、`writeMemoryDoc`） | **复用（不改原文件）**：复用 `hashMemoryText` 及路径安全约束；控制面三层记忆与待确认队列落盘到独立 SQLite `memory-skill.sqlite`（VM 只读副本，遵循 MVP1.5 边界） |
| 主题头与索引 | 已有 | `server/memory-topics.ts`（`parseTopicHeader`、`renderTopicIndex`、`mergeTopicText`） | **保留不改**：用于现有 Bot workspace 主题文件，不侵入原逻辑 |
| 记忆审计日志 | 已有 | `server/memory-journal.ts`（`MemoryJournalEntry`、`unifiedDiff`、workspace 外独立日志） | **参考复用（不改原文件）**：控制面技能变更日志与回滚记录遵循同样“workspace 外存审计，Bot 无法篡改”的原则 |
| 记忆整理去重 | 已有 | `server/memory-tidy.ts`（`planTidy`、`applyTidy`、`contradictionPrompt`） | **保留不改**：现有单 Bot 笔记本整理逻辑保持不变 |
| 技能学习标准 | 已有 | `server/skill-learn.ts`（`parseLearnCommand`、`AUTHORING_STANDARDS`、`buildLearnPrompt`） | **参考复用（不改原文件）**：沉淀技能时校验必填五要素（输入、输出、工具、边界、失败处理） |
| 后台技能回顾 | 已有 | `server/skill-review.ts`（`turnToolSteps`、`ReviewSkill`、`SKILL_REVIEW_MARKER`） | **保留不改**：原逻辑按工具步数触发；MVP5 在控制面新增“重复 ≥ 3 次流程沉淀 + Curator 生命周期” |
| 技能库加载 | 已有 | `server/skill-library.ts`（`parseSkillManifest`、`loadBundledSkills`、`loadUserSkills`） | **保留不改**：不改原内置技能库加载；租户隔离与控制面版本/回滚在 `server/memory-skill/` 独立管理 |
| 技能开关与哈希校验 | 已有 | `server/skill-switch.ts`（`skillSwitchTarget`、`skillSwitchStillMatches`、SHA-256 `contentSha256`） | **参考复用（不改原文件）**：借鉴其 SHA-256 校验思路；核心技能锁（采购 / 付款 / 数据删除）哈希表新建于控制面 SQLite |
| 企业共享技能库 | 已有 | `server/org-library.ts`（`OrgLibraryEntry`、包签名与下发） | **本 change 不动**：按 proposal 边界，不做跨客户/企业共享技能下发，仅保留隔离与后续扩展位 |
| MVP4 最小 Ontology 字段 | 已有 | `server/patrol/adapters.ts`、`shared/patrol.ts`（`CanonicalInventoryItem`、`CanonicalOrderItem`） | **直接复用 + 最小延伸**：复用库存与订单规范字段类型，仅在 `shared/memory-skill.ts` 延伸 `preference` 与 `rule` 两类域共用切片，不建全量 10 实体 |
| 高影响记忆待确认确认流 | 已有基础 | `server/approvals/engine.ts`（`ApprovalEngine`、`ApprovalCard`、飞书交互卡片与双口径预算） | **新建待确认队列 + 复用飞书卡片格式**：高影响记忆（白名单、付款规则、供应商选择、价格底线）入控制面待确认列表，支持生成飞书群逐条确认卡片及确认/拒绝回调；复盘 token 独立记账复用双口径预算口径 |
| 核心技能锁哈希表 | 无现成控制面表 | 尚无独立的控制面核心技能锁存储表 | **要新建**：在 `server/memory-skill/store.ts`（`memory-skill.sqlite`）新建核心技能锁哈希表、技能版本与变更日志表、三层记忆表、待确认记忆表及复盘 token 账本 |
| 控制面 HTTP 路由与宿主 | 要新建 | 参考 `server/patrol/host.ts`、`server/routes/patrol.ts` | **要新建**：`shared/memory-skill.ts`、`server/memory-skill/{store,engine,host,memory-skill.test}.ts`、`server/routes/memory-skill.ts`，并在 `server/index.ts` 挂载 |

## 批准

- 批准：R1，2026-11-26 18:19，维护者在对话中明确确认“ok我批准了”，可以做，范围只限 proposal 里写的，不扩范围。
- 要扩大范围，必须出 R2，重新批。不能在改代码的时候偷偷扩。尤其注意：不要在 MVP5 里建全量 Ontology，不要在 MVP5 里做跨客户共享技能，不要把核心技能锁改回分档。

## 做到哪了

- tasks.md 第 0–3 步（0–9 项）：全部完成。
- tasks.md 第 4 步第 10 项（逐条测试 + 隔离端到端）：全部通过。
- tasks.md 第 4 步第 11 项（最终审计 + `openspec archive add-memory-skill` + 推送 GitHub）：等待维护者最终审核确认后执行。

## 本次变更文件清单

- 新增：`shared/memory-skill.ts`（三层记忆、待确认飞书卡片、最小 Ontology 切片、每晚复盘、技能五要素、Curator 与核心技能锁类型定义）
- 新增：`server/memory-skill/store.ts`（独立控制面 SQLite `memory-skill.sqlite` 持久化：三层记忆表、待确认队列、污染事件表、复盘独立 token 账本、技能库、核心锁哈希表、版本快照、变更日志与拒绝审计表）
- 新增：`server/memory-skill/engine.ts`（`MemorySkillEngine`：三层记忆读写与同 VM 多 Bot 共享/私有隔离、周末不下单规则检查、只写记忆每晚复盘、外部指令注入污染防护、高影响记忆待确认流、重复 ≥ 3 次五要素技能沉淀、租户隔离一句话触发、Curator 生命周期与重复合并、核心技能锁运行时哈希校验及非核心自由修改/回滚）
- 新增：`server/memory-skill/host.ts`（宿主工厂 `createMemorySkillHost`）
- 新增：`server/routes/memory-skill.ts`（控制面 HTTP 路由 `/api/memory-skill/*`）
- 新增：`server/memory-skill/memory-skill.test.ts`（13 项单测与坏情况测试，覆盖全部 11 条 spec 场景 + Curator + HTTP 路由）
- 修改：`server/index.ts`（3 处挂载：`createMemorySkillHost` 导入、实例化与 `memorySkill.routes` 注册，未改动原聊天/审批/路由/巡检逻辑）
- 文档：`openspec/changes/add-memory-skill/{design.md,handoff.md,tasks.md,specs/memory-skill/spec.md}`

## 验证证据（2026-11-26）

- MVP5 + MVP2a/2b/4 Vitest：`./node_modules/.bin/vitest run server/memory-skill/memory-skill.test.ts server/patrol/patrol.test.ts server/approvals/approvals.test.ts server/tickets/tickets.test.ts` → **4 files / 38 passed（MVP5 新增 13/13）**
- 既有模块回归 Vitest：`./node_modules/.bin/vitest run server/routing/ server/memory-dream.test.ts server/memory-store.test.ts server/skill-learn.test.ts server/skill-switch.test.ts` → **5 files / 94 passed**
- 静态检查：`./node_modules/.bin/oxlint shared/memory-skill.ts server/memory-skill/ server/routes/memory-skill.ts` → **0 warnings, 0 errors**
- 类型检查：`./node_modules/.bin/tsc --noEmit` → **0 errors**
- OpenSpec 严格校验：`openspec validate --all --strict --no-interactive` → **8 passed, 0 failed**
- 隔离端到端 HTTP 验证：通过 `node --experimental-strip-types scripts/control-omb.ts launch` 启动独立临时实例（`http://127.0.0.1:20247`，未触碰真实数据），逐条跑通全部 **11/11** spec 场景后发送 `SIGINT` 自动清理临时目录。

## 恢复方式

- 如需回退本次代码改动，仅需还原 `server/index.ts` 中 3 处 `memorySkill` 挂载并删除 `shared/memory-skill.ts`、`server/memory-skill/`、`server/routes/memory-skill.ts`，不影响任何已有模块与数据。

## 卡在哪

- 无。等 R1。

## 下一步

1. 用户批 R1（回“可以做”）。
2. 在 Mac 上：
   ```bash
   cd /Users/latiao/OpenMausBot
   openspec new change add-memory-skill
   ```
   把本包的 5 个文件复制到刚生成的同名目录里，**文件要和隐藏的 `.openspec.yaml` 在同一层，不要嵌套一层多余的文件夹**。
3. 按 tasks.md 第 0 步做复用盘点，填上面“复用盘点”一节，再做第 2–3 步。
4. 按 specs/memory-skill.md 一条一条测，在隔离测试环境中测，尤其要测记忆污染和高影响记忆待确认。
5. `openspec validate --all --strict --no-interactive` 通过后，`openspec archive add-memory-skill`，再推到 GitHub。
6. 然后开 MVP6 `add-isolation-deploy`。
