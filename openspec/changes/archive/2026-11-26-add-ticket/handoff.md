# Handoff: MVP2a 工单 `add-ticket`

- Change: `add-ticket`（R1）
- 主执行者：Antigravity（本会话）
- 授权状态：R1 已批准并完成开发与隔离验证；变更已归档，用户于 2026-11-26 明确要求提交并推送本机修改，当前正在发布。
- 授权出处：本会话用户于 2026-11-26 15:57 指示“/Users/latiao/OpenMausBot/openspec/changes/add-ticket/tasks.md，按照 tasks.md 文件里的任务，帮我不断完成步骤，并且自己去进行测试，我只负责最后成果的审核和关键步骤的审核”；按本版 proposal 范围登记为 R1，不扩围。
- 分支与基线：`main`，代码基线 `5987204e3`，工作基线 `92eb6457ff128d4bbbd622ab9e4b42da4200f473`，MVP1.5 已归档提交 `2a15dc0b9`
- 最近验证：`vitest` 8/8 通过、`pnpm typecheck` 0 错误、隔离 harness 端到端 8/8 场景全通过、`openspec validate --all --strict --no-interactive` 4/4 通过。
- 发布授权：用户本会话指示“帮我把本机文件里的修改提交并推送到github仓库”，授权发布当前工作区全部变更。
- 下一步：将本机全部 Git 变更提交并推送至 `origin/main`，完成后更新 Task 13。

## 复用盘点（第 0 步）

| 模块 / 文件 | 状态 | 现状与处理方式 |
|---|---|---|
| `server/app-triggers.ts` | 已有，不改核心 | 管理 Composio 应用事件自动化，通过 `runs.enqueue` / `runs.receipt` 接入 `RoutineManager` |
| `server/bot-automations.ts` | 已有，不改 | Bot 删除时级联清理 schedules / webhooks / app events / waits |
| `server/routines.ts` & `server/webhooks.ts` | 已有，轻量挂接 | 现有 Trigger 入口；在 `server/index.ts` 的 `webhooks.enqueue` 中非侵入式桥接外部 Webhook 事件至 `tickets.intakeExternalWebhook`（`observe` 状态），不重写 Trigger 调度器 |
| `server/routine-event-receipts.ts` | 已有，直接复用 | 复用 `EVENT_RETRY_WINDOW_MS`（7 天）去重回执窗口 |
| `server/routine-run-gate.ts` | 已有，直接复用 | 复用 `createRunGate` 门控语义 |
| `server/routine-recovery.ts` | 已有，不改 | Ticket 与回执落独立 SQLite，重启后自动恢复不重复生成 |
| MVP1 飞书网关（`scripts/feishu_relay.py`） | 已有 | `deliveries` 表已保存 `event`（`event_id`）和 `message`（`message_id`）并带唯一约束；白名单在 `Relay.routes` 层校验；`event_id` 可直接复用为 Ticket 去重键 |
| MVP1.5 `decide-tenancy-architecture` | 已批 R1 并归档 | 位于 `openspec/changes/archive/2026-11-26-decide-tenancy-architecture/`，生效规范在 `openspec/specs/tenancy-architecture/spec.md` |

## 逐文件用途

- `shared/tickets.ts`：Ticket、Mandate、双口径预算（`tokenLimit` / `businessLimit`）、签名只读副本（`SignedMandateCopy`）、入票判定与审计日志的公开契约类型。
- `server/tickets/mandate.ts`：Mandate 规范化序列化、SHA-256 内容哈希、HMAC-SHA256 只读副本签名与防篡改校验。
- `server/tickets/classifier.ts`：确定性代码规则分类器（严禁调用模型），区分普通对话/只读查询、副作用工作、会话中途副作用与外部事件。
- `server/tickets/store.ts`：基于 `node:sqlite` 的独立控制面 SQLite 存储（`DATA_DIR/tickets.sqlite`，权限 `0600`，WAL 模式），含 `tickets`、`ticket_receipts`、`ticket_audit_log` 三表及事务性写入/作废替换。
- `server/tickets/engine.ts`：`TicketEngine`（唯一写工单者），实现白名单鉴权、按 `event_id` 或内容哈希+时间窗口去重、外部事件默认 `observe`、白名单私聊正常回复、Mandate 修订（旧单 `superseded` + 新单 `parentId` 关联）、以及 agent 修改 Mandate 拒绝与审计记录。
- `server/routes/tickets.ts`：控制面 HTTP 接口（`POST /api/tickets/intake`、`GET /api/tickets`、`GET /api/tickets/:id`、`GET /api/tickets/:id/mandate`、`PATCH|PUT /api/tickets/:id/mandate` & `POST /api/tickets/:id/mandate/mutate` 403 拒绝并记审计、`POST /api/tickets/:id/revise`、`GET /api/tickets/audit`）。
- `server/tickets/host.ts`：组合 `TicketEngine`、HTTP routes、外部 Webhook observe 接入与 SQLite 关闭；`server/index.ts` 仅创建 host、挂载 routes 并在关机时释放。
- `server/index.ts`：在 `webhooks.enqueue` 接入外部事件 `observe` 入票，继续应用 usage cap 并调用原有 Routine 队列。
- `server/tickets/tickets.test.ts`：单元测试与路由测试（8 个用例）。
- `openspec/changes/add-ticket/.openspec.yaml`、`specs/ticket/spec.md`、`tasks.md`、`handoff.md`：OpenSpec 元数据、校准后的严格规范、任务进度与交接记录。

## 验证命令与结果

1. **单元测试**：`pnpm exec vitest run server/tickets/tickets.test.ts` → **8/8 通过**（覆盖副作用建单、普通对话绕过、会话中途建单、去重与重启恢复、非白名单拒绝、外部事件 `observe` vs 白名单私聊、Mandate 哈希/签名/修订/防篡改拒绝、HTTP 路由 403 拒绝）。
2. **全仓类型检查**：`pnpm typecheck` → **退出码 0，0 错误**。
3. **隔离端到端验证**：启动独立临时 `OMB_DATA_DIR` 与随机端口的真实 `server/dev-server.ts`（不触碰本机运行实例与真实数据），逐条验证 `specs/ticket/spec.md` 的 8 个场景 → **ALL ISOLATED E2E TICKET SCENARIOS PASSED**，验证 `tickets.sqlite` 权限为 `0600` 且 6 类审计事件全部落库，测完自动终止进程并清理临时目录。
4. **OpenSpec 严格校验**：`openspec validate --all --strict --no-interactive` → **4 passed, 0 failed**。
5. **静态检查与回归**：`pnpm exec oxlint --deny-warnings shared/tickets.ts server/tickets/ server/routes/tickets.ts` → **0 warnings, 0 errors**；`pnpm exec vitest run server/webhooks.test.ts` → **43/43 通过**。
6. **组合根文件长度约束**：首次 push 被 `file-size-ratchet.test.ts` 拒绝，`server/index.ts` 超出基线 10 行。将 Ticket 创建、route 与关闭职责抽到 `server/tickets/host.ts`，后续 `wc -l server/index.ts` 为 15,276，`pnpm typecheck` 退出码 0。

## 批准记录

- 批准：R1，2026-11-26，可以做，范围只限 proposal 里写的，不扩范围。
- 出处：本会话用户 2026-11-26 15:57 指令。
- 最终发布决定：用户于 2026-11-26 明确要求提交并推送本机文件修改；本次按该指令发布所有工作区变更。

## 回滚与恢复方法

- 需要撤销已发布的代码时，使用新的 revert commit 回滚对应提交，不改写已推送历史。
- `DATA_DIR/tickets.sqlite` 为独立 SQLite 文件；删除会移除 Ticket 数据，但不影响 OpenMausBot 原有会话与配置数据。
