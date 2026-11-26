# Handoff: MVP4 只读巡检 `add-readonly-patrol`

- Change: `add-readonly-patrol`
- 阶段：MVP4，MVP3 之后、MVP5 之前
- 时间：3–5 天
- 状态：**已通过维护者最终审核并归档推送**（维护者 2026-11-26 确认通过）
- 主执行者：Antigravity
- 分支与基线：`main` @ `19fb7db`（代码基线 `5987204e3`）
- 最近验证：Vitest 35/35 通过（含 `patrol.test.ts` 10/10、`tickets.test.ts` 8/8、`approvals.test.ts` 7/7、`routing.test.ts` 8/8、`file-size-ratchet.test.ts` 1/1、`index-route-ratchet.test.ts` 1/1）；`tsc --noEmit` 0 错误；`oxlint --deny-warnings` 0 警告 0 错误；隔离 `control-omb` harness 端到端 HTTP 7/7 场景全通过；`openspec validate --all --strict --no-interactive` 7/7 项全通过。
- 下一步：已归档并推送至 `origin/main`，可继续开启 MVP5 `add-memory-skill`。
- 依据：`~/workspace/personal-agent-mvp1-upgrade-roadmap.md`（2026-11-26 新版）MVP4 节

## 核对记录（2026-11-26 17:26，Muse 核对 GitHub `origin/main`）

- 最新 HEAD：`19fb7db` — `add-routing: 实现 MVP3 门口 Jev 快分流、里面 Router-Worker 与 40 条路由 evals`
- MVP3 已完成并归档推送，内容与本包的 proposal 一致：
  - 门口 Jev 快分流（固定规则优先 + 可选 500ms / 0.6 阈值小模型 + 不确定回落 lead bot，绝不生成工单）
  - 里面 Router-Worker（复用 MVP2a 确定性分类器 + `TicketEngine.intake` 生成副作用工单）
  - 飞书群 `@` 门控、Specialist 禁止直发群、Bot 自身消息防循环、`max_hops = 4` 超限交回给人
  - 40 条 `evals/routing/cases.json` 样例集（查库存 6 条、跟工厂 6 条、下单 6 条、查价格 6 条、查物流 6 条、闲聊 5 条、模糊消息 5 条）
  - 文件：`server/routing/jev.ts`、`engine.ts`、`host.ts`、`routing.test.ts`、`server/routes/routing.ts`、`shared/routing.ts`、`evals/routing/cases.json`；`openspec/changes/archive/2026-11-26-add-routing/`；`openspec/specs/routing/spec.md`
- 验证记录（见该提交的 handoff）：`vitest` 24/24 通过（`routing.test.ts` 8/8 含 40 条 evals 准确率达标 + `approvals.test.ts` 7/7 + `tickets.test.ts` 8/8 + `file-size-ratchet.test.ts` 1/1）、`oxlint --deny-warnings` 0 错误、`pnpm typecheck` 0 错误、隔离 harness 端到端 7/7 场景全通过、`openspec validate --all --strict --no-interactive` 全通过。
- 路由准确率：误派率 0%（< 5%）、回落率 12.5%（5/40，< 20%），达标。
- **结论：没问题，可以开 MVP4。**
- **未阻塞 MVP4，但要记下来**：
  - 飞书群消息权限：handoff 里写的是“飞书开放平台开启群消息接收权限后直连”，说明群消息接收权限在提交时还没在开放平台开好，**真实群聊 @ 测试还没做**。MVP3 的 7/7 端到端是隔离环境跑的，不是真实飞书群。开 MVP4 之前或并行，把群权限开了，在真实群里 @ 一次，确认能收到、能分流、能回，再算 MVP3 真正闭环。
  - MVP1 仍有两项待验收：另一个白名单外账号、整机断网恢复（`lark-cli` 同凭据竞争消费者未清除，全断网恢复验收仍待做）。
  - 服务端集成测试受 `listen EPERM` 阻塞，未误标完整回归通过。
  - 自建业务系统完整出口凭据注入，另开 `add-credential-proxy`，不在 MVP2b / MVP3 里做。

## 已确认的基线

- 代码基线：`5987204e3`
- 工作基线：`92eb6457ff128d4bbbd622ab9e4b42da4200f473`
- 最新 HEAD：`19fb7db`（2026-11-26）
- 本地路径：`/Users/latiao/OpenMausBot`
- 远程仓库：https://github.com/latiao-ai/personal-agent
- MVP0：已跑通，等 `bootstrap-dev-workspace` 最终审计。
- MVP1：已到 R2 收尾，剩下另一个白名单外账号验收、整机断网恢复验收、维护者最终审计。
- MVP1.5：已批 R1，2026-11-26 15:20，已归档推送 `2a15dc0`。
- MVP2a：已完成并归档推送 `7d978df`。
- MVP2b：已完成并归档推送 `786516d`。
- MVP3：已完成并归档推送 `19fb7db`。

## 复用盘点（第 0 步，已完成本地核对）

| 模块路径 | 本地状态 | 本变更处置 | 说明 |
|---|---|---|---|
| `server/app-triggers.ts`、`server/bot-automations.ts` | 已有 | 复用（不改） | 现有自动化触发与 Bot 生命周期绑定，巡检不重写触发框架 |
| `server/routine-run-gate.ts` | 已有 | 复用（不改） | `createRunGate` 已提供运行门控，巡检复用其门控语义并加活跃运行防重叠锁 |
| `server/routine-bounds.ts`、`server/routine-recovery.ts`、`server/routine-event-receipts.ts` | 已有 | 复用（不改） | 运行时限与 7 天事件回执去重（`EVENT_RETRY_WINDOW_MS`），巡检沿用同等边界语义 |
| `server/tickets/classifier.ts`、`server/tickets/engine.ts` | 已有 | 直接调用（不改） | `TicketSource` 已含 `"patrol"`，巡检只读 Ticket 与大问题升级执行 Ticket 均直接调用 `TicketEngine.intake` |
| `server/approvals/engine.ts`、`server/approvals/budget.ts` | 已有 | 直接调用（不改） | 大问题生成的执行 Ticket 直接送入 `ApprovalEngine.evaluate` 走 MVP2b 四层审批 |
| `server/permission-proxy.ts`、`server/auto-approve.ts`、`server/always-allow.ts` | 已有 | 复用语义（不改） | 原版权限代理负责 MCP 工具审批；巡检在控制面工具层新建 `server/patrol/permission-guard.ts`，按巡检 Ticket Mandate 白名单硬拦截 |
| `server/spend.ts`、`server/harness-budget.ts` | 已有 | 不改（独立记账） | 原版全局月度花费与工具超时预算不动；巡检在 `server/patrol/store.ts` 独立记账巡检 token，不与工作 token 混淆 |
| 库存与新订单假数据 fixture | 无现成业务 fixture | 新建 | 新建 `server/patrol/fixtures.ts`（正常场景 + 异常/库存不足/新订单/超24h未发货/提示词注入场景） |
| 只读巡检控制面模块 | 无 | 新建 | `shared/patrol.ts`、`server/patrol/{adapters,permission-guard,store,engine,fixtures,host}.ts`、`server/routes/patrol.ts`、`server/patrol/patrol.test.ts` |
| `server/index.ts` | 已有 | 最小接线 | 仅按 MVP2a/2b/3 模式接入 `createPatrolHost` 与 `patrol.routes` |

## 批准

- 批准：R1，2026-11-26，维护者在对话中明确批准按 `tasks.md` 连续实施并自测，范围仅限 proposal 所列内容，不扩范围；最终成果审核与归档由维护者决定。
- 要扩大范围，必须出 R2，重新批。不能在改代码的时候偷偷扩。尤其注意：不要在 MVP4 里把 6 类数据源都接真实平台，不要在 MVP4 里建全量 Ontology。

## 做到哪了

- tasks.md 第 0–3 步及第 4 步第 9–10 项已全部完成并自测通过：
  - 新增文件：
    - `shared/patrol.ts`：MVP4 只读巡检控制面契约、最小规范字段（库存/订单）、4 类预留接口、只读工具白名单常量、三档结果与独立巡检 token 账本类型。
    - `server/patrol/adapters.ts`：控制面字段映射表（淘宝 `stock` / Shopify `inventory_quantity` / 京东 `stockNum` / ERP `on_hand_qty` -> `available_quantity`；平台订单状态 -> 标准状态），库存与新订单两个可用适配器，以及价格/物流/供应商回复/爆品信号 4 个空实现桩适配器。
    - `server/patrol/permission-guard.ts`：工具层只读权限代理，绑定巡检 Ticket 不可变 Mandate 白名单，硬拦截写/发消息/付款/控浏览器调用并记录拒绝审计。
    - `server/patrol/store.ts`：独立控制面 SQLite（`patrol.sqlite`，0600 权限，WAL），持久化巡检运行记录、每日日报（一天最多发一次）、增量水位线与摘要缓存、工具拦截审计、独立巡检 token 花费账本。
    - `server/patrol/engine.ts`：`PatrolEngine`（复用 `createRunGate` 防重叠跳过 + 单次运行时限超时中止 + 复用 MVP2a `TicketEngine` 创建只读巡检 Ticket 与大问题执行 Ticket + 复用 MVP2b `ApprovalEngine` 走四层审批 + 小模型巡检/异常大模型复核/增量与摘要缓存）。
    - `server/patrol/fixtures.ts`：3 套隔离假数据（`normal`、`low_stock`、`prompt_injection`）。
    - `server/patrol/host.ts` 与 `server/routes/patrol.ts`：控制面组装与 HTTP 接口（`/api/patrol/run`、`/api/patrol/order-event`、`/api/patrol/runs`、`/api/patrol/digest`、`/api/patrol/digest/dispatch`、`/api/patrol/spend`、`/api/patrol/denials`、`/api/patrol/fixtures`）。
    - `server/patrol/patrol.test.ts`：10 项单元测试，逐条覆盖 `specs/patrol/spec.md` 全部场景。
  - 修改文件：
    - `server/index.ts`：仅最小接线导入 `createPatrolHost` 并挂载 `patrol.routes`（未改 Ticket/Approval/Routing 内部逻辑，通过文件大小与路由棘轮测试）。
    - `openspec/changes/add-readonly-patrol/specs/patrol/spec.md`：按 OpenSpec strict 规范对齐路径与 `MUST` 约束。
- 验证证据（2026-11-26）：
  - `./node_modules/.bin/vitest run server/patrol/patrol.test.ts server/tickets/tickets.test.ts server/approvals/approvals.test.ts server/routing/routing.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts`：6 个测试文件 35/35 通过。
  - `./node_modules/.bin/tsc --noEmit`：0 错误。
  - `./node_modules/.bin/oxlint --deny-warnings shared/patrol.ts server/patrol/ server/routes/patrol.ts`：0 警告 0 错误。
  - 隔离环境端到端验证（`scripts/control-omb.ts launch` 一次性临时目录实例，`http://127.0.0.1:20926`）：7/7 场景全通过（正常巡检只写记录 + 复跑命中缓存 + 库存不足与超24h未发货升级执行 Ticket 并触发 MVP2b 审批卡片 + 日报一天一次 + 新订单事件触发增量巡检 + 提示词注入调用发消息/付款/控浏览器在工具层被拒并持久化 4 条拒绝记录 + 独立巡检 token 账本校验）。
  - `openspec validate --all --strict --no-interactive`：7/7 通过（含 `change/add-readonly-patrol`）。

## 卡在哪

- 无。待维护者最终审核；审核通过后再执行第 11 步归档与推送。

## 下一步

1. 维护者审核本变更代码与验证证据。
2. 审核通过后执行：`openspec archive add-readonly-patrol`，更新 `openspec/WORKSPACE.md`，再次运行 `openspec validate --all --strict --no-interactive`，提交并推送到 `origin/main`。
3. 如需撤回：删除新增的 `shared/patrol.ts`、`server/patrol/`、`server/routes/patrol.ts` 及还原 `server/index.ts` 中 3 处接线行即可，不触碰已有数据库或用户数据。
