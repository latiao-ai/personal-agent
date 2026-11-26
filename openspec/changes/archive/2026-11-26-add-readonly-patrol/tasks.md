# Tasks: MVP4 只读巡检 `add-readonly-patrol`

- 时间：3–5 天
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手）

- [x] 0. 对照本地目录，列出已有模块：`server/app-triggers.ts`、`server/bot-automations.ts`、`server/routine-*.ts`、`routine-run-gate.ts`、`routine-event-receipts.ts`、`routine-recovery.ts`、`server/tickets/classifier.ts`、`server/tickets/engine.ts`、`server/permission-proxy.ts`、`auto-approve.ts`、`always-allow.ts`、`server/spend.ts`、`harness-budget.ts`。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 MVP3 已完成并推送（最新提交 `19fb7db`）：两层群聊路由、40 条 evals、误派率 0%、回落率 12.5%，本 change 不改路由。
- [x] 0. 确认 MVP2a / MVP2b 已完成：`TicketEngine` 和四层审批都已实现，巡检发现大问题时直接调用，不要重写。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：`openspec new change add-readonly-patrol`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [x] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好，核对一遍本地目录名和函数名，错的改过来。
- [x] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：只读巡检骨架

- [x] 4. 巡检 Ticket：复用 MVP2a `TicketEngine`，建一个只读的定时 Trigger，挂在现有 routine 上。Mandate 工具白名单里只有读接口。
- [x] 5. 只读限制在工具层：权限代理按白名单拦截，写 / 发消息 / 付款 / 控浏览器接口一律不在白名单里。提示词里写“不要写”只是辅助，不算数。
- [x] 6. 数据源适配器：先做通库存和新订单两类，输出最小规范字段（见 design.md 3.4）。价格、物流、供应商回复、爆品信号只留接口定义和空实现，不接真实数据源。

## 第 3 步：结果分档与省 token

- [x] 7. 结果分档：没问题只写记录；小问题写日报（一天一次）；大问题生成执行 Ticket，带证据，走 MVP2b 审批。
- [x] 8. 省 token：小模型巡检，发现异常再用大模型；只查增量；用缓存和摘要；巡检 token 单独记一笔。

## 第 4 步：测 + 归档

- [x] 9. 按 specs 一条一条测，不要只测 happy path，也要测坏情况（见 specs/patrol/spec.md），尤其要测提示词诱导发消息被拦截。
- [x] 10. 先写 2 套假数据再测：一套正常、一套库存不足，不要用真实数据测。
- [x] 11. 审计 + 归档：`openspec validate --all --strict --no-interactive` 通过，`openspec archive add-readonly-patrol`，再推到 GitHub。（维护者 2026-11-26 确认通过，已完成归档与推送）
