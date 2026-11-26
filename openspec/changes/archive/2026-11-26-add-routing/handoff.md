# Handoff: MVP3 路由 `add-routing`

- Change: `add-routing`（R1）
- 主执行者：Antigravity（本会话）
- 授权状态：R1 已批准；全部测试与 evals 样例集准确率一次性通过，按维护者规则直接归档并推送至 `origin/main`
- 授权出处：本会话用户于 2026-11-26 16:40 指示按 `add-routing/tasks.md` 自动完成并测试；并沿用 2026-11-26 16:12 规则（测试一次性全部通过即可直接 `openspec archive`、复验 `openspec validate --all --strict --no-interactive`、提交并推送至 `origin/main`）。
- 分支与基线：`main`，基线 `786516d35`（MVP2b `add-approval` 已归档推送）
- 最近验证：`vitest` 24/24 通过（`routing.test.ts` 8/8 含 40 条 `evals/routing/cases.json` 准确率达标 + `approvals.test.ts` 7/7 + `tickets.test.ts` 8/8 + `file-size-ratchet.test.ts` 1/1）、`oxlint --deny-warnings` 0 错误、`pnpm typecheck` 0 错误、隔离 harness 端到端 7/7 场景全通过、`openspec validate --all --strict --no-interactive` 全通过。
- 下一步：无；下一阶段可开启 MVP4 `add-readonly-patrol`。

## 复用盘点（第 0 步）

| 模块 / 文件 | 状态 | 现状与处理方式 |
|---|---|---|
| `docs/decision-model.md` | 已有，不改 | 定义 Jev / Workers AI / OpenRouter 快决策模型、0.6 置信度阈值与失败回落 lead bot 语义 |
| `server/ask-routing.ts` | 已有，不改 | Team Cloud 问询/通知收件人路由，非群聊消息分流 |
| `server/local-routing.ts` | 已有，不改 | 本地电脑 vs 云电脑挂载决策 |
| `server/room-routing-members.ts` | 已有，不改 | `roomTurnMembers` / `autoRoomDefault` 提供自动房间回落 lead bot 语义 |
| `server/chief-of-staff.ts` | 已有，不改 | Manager Bot（Chief of Staff）单入口汇总回复与队友委派约定 |
| `server/tickets/classifier.ts` & `server/tickets/engine.ts` | 已有，直接复用 | Router 直接调用 MVP2a 确定性分类器与 `TicketEngine.intake` 生成副作用工单，不重写 |
| 飞书群消息权限 | 控制面已接入 | MVP1 仅订阅私聊 `chat_type=p2p`；本 change 实现群聊 `@` 门控与 Bot 自身消息防循环过滤（`/api/routing/group-message`），飞书开放平台开启群消息接收权限后直连 |
| `evals/` 目录 | 已有，新增 `evals/routing/cases.json` | 建立 40 条标准样例集（覆盖查库存、跟工厂、下单、查价格、查物流、闲聊、模糊消息），实测误派率 0%（< 5%）、回落率 12.5%（5/40，< 20%） |

## 逐文件用途

- `shared/routing.ts`：门口 Jev 决策、飞书群消息入参、Router 派发结果、Specialist 回复约束与路由审计日志公开契约。
- `server/routing/jev.ts`：门口 Jev 快分流（固定规则优先 + 可选 500ms/0.6 阈值小模型 + 不确定回落 lead bot，绝不生成工单）。
- `server/routing/engine.ts`：`RoutingEngine`，串联 Bot 自身消息防循环过滤、群聊 `@` 门控、`max_hops = 4` 超限交回给人、门口 Jev、里面 Router（复用 MVP2a `classifyIntake` + `TicketEngine`）、以及 Specialist 禁止直发群校验。
- `server/routes/routing.ts` & `server/routing/host.ts`：控制面 HTTP 路由（`/api/routing/group-message`、`/api/routing/specialist-reply`、`/api/routing/audit`）与 host 工厂。
- `server/index.ts`：零增行挂载 `createRoutingHost(tickets.engine)`（保持 15276 行通过 `file-size-ratchet.test.ts`）。
- `evals/routing/cases.json` & `server/routing/routing.test.ts`：40 条路由基准样例集与 8 个单元测试。
