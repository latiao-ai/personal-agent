# Handoff: MVP2b 审批 `add-approval`

- Change: `add-approval`（R1）
- 主执行者：Antigravity（本会话）
- 授权状态：R1 已批准；全部测试一次性通过，按维护者规则直接归档并推送至 `origin/main`
- 授权出处：本会话用户于 2026-11-26 16:20 指示按 `add-approval/tasks.md` 自动完成并测试；并于 2026-11-26 16:12 明确“下次如果是测试一次性全部通过的话，可以直接执行 `openspec archive` 并复验 `openspec validate --all --strict --no-interactive`，然后按格式提交变更并推送到 `origin/main`”。
- 分支与基线：`main`，基线 `ea2562388`（MVP2a `add-ticket` 已归档推送）
- 最近验证：`vitest` 16/16 通过（`approvals.test.ts` 7/7 + `tickets.test.ts` 8/8 + `file-size-ratchet.test.ts` 1/1）、`oxlint --deny-warnings` 0 错误、`pnpm typecheck` 0 错误、隔离 harness 端到端 8/8 场景全通过、`openspec validate --all --strict --no-interactive` 全通过。
- 下一步：无；下一阶段可开启 MVP3 `add-routing`（自建业务系统完整出口凭据注入另开 `add-credential-proxy`）。

## 复用盘点（第 0 步）

| 模块 / 文件 | 状态 | 现状与处理方式 |
|---|---|---|
| `docs/approval-levels.md` | 已有，不改 | 记录 Bot/Thread 的 provider 审批级别（Ask / Edits / Approve for me / Full / Custom） |
| `server/permission-proxy.ts` | 已有，不改 | Claude CLI stdio 权限代理，经 unix socket 转发给 broker |
| `server/auto-approve.ts` & `server/always-allow.ts` | 已有，不改 | 管理 provider 模式与 Bot/Thread 级 `MAX_ALWAYS_ALLOW=200`；控制面 Ticket 级 `Always allow` 按 `(tenantId, initiator, actionCategory, toolName, maxBusinessLimit)` 独立限定 |
| `server/decision-log.ts` | 已有，不改 | Fleet 月度 NDJSON 决策日志；控制面审批审计同时落独立 SQLite（`approvals.sqlite`）供精确按 Ticket/批准人/双口径金额查询 |
| `server/spend.ts` & `server/harness-budget.ts` | 已有，不改 | `spend.ts` 仅管工作区级模型 token 月度花费；`harness-budget.ts` 是代理超时常量。本 change 新建双口径单笔/日/月预算引擎（`server/approvals/budget.ts`） |
| `server/cloud-secrets.ts` | 已有，直接复用 | 复用 `withoutCloudSecrets` 剥离宿主机密钥，叠加租户级 Vault 真实凭据剥离，确保 agent 进程仅拿到临时替身 token |
| 飞书卡片回调 `card.action.trigger` | 新增控制面接口 | MVP1 `scripts/feishu_gateway.py` 仅订阅 `im.message.receive_v1`；本 change 实现飞书交互卡片 JSON 载荷与 `/api/approvals/cards/callback` 回调校验（批准人 `open_id`、过期、原子幂等），飞书开放平台开启 `card.action.trigger` 权限后即可直连 |
| MVP2a `Ticket.mandate.approver` | 已有，兼容默认 | MVP2a 默认 `approver: null`；当 `approver` 未指定时默认仅 `initiator` 可批，审批通过后落库记录实际 `approverOpenId` |

## 逐文件用途

- `shared/approvals.ts`：四层审批、飞书交互卡片与回调、双口径预算政策、临时替身 token 与审批审计记录的公开契约类型。
- `server/approvals/budget.ts`：双口径（模型 token + 业务花费）单笔 / 日 / 月硬规则预算校验。
- `server/approvals/tiers.ts`：固定顺序的动作分类与受保护评审模型调用器（只允许风险上调，禁止放行花钱动作，超时/报错/乱输出一律降级为第 3 层弹卡片）。
- `server/approvals/vault.ts`：按租户隔离的 `ControlPlaneVault`，支持真实凭据分区托管、内嵌预算与工具白名单的单次临时替身 token 签发/核销，以及 `buildAgentProcessEnv` 剥离真实凭据。
- `server/approvals/store.ts`：基于 `node:sqlite` 的控制面持久化（`DATA_DIR/approvals.sqlite`，权限 `0600`，WAL 模式），提供原子条件更新防并发重复点击。
- `server/approvals/engine.ts`：`ApprovalEngine`，串联四层审批、飞书卡片生成、批准人/过期/幂等回调校验、预算入账、替身 token 签发与审计落库。
- `server/routes/approvals.ts` & `server/approvals/host.ts`：控制面 HTTP 路由与 host 工厂。
- `server/index.ts`：零增行挂载 `createApprovalHost(DATA_DIR)`（保持 15276 行通过 `file-size-ratchet.test.ts`）。
- `server/approvals/approvals.test.ts`：7 个单元测试用例，覆盖全部 10 条 specs 需求。

## 批准与归档记录

- 批准：R1，2026-11-26，范围严格限于 proposal，未改 Ticket 生成逻辑，未包含 `add-credential-proxy`。
- 验证：全部单元测试、静态检查、全仓类型检查、隔离端到端 8 场景、OpenSpec 严格校验一次性全部通过。
