# Tasks: MVP3 路由 `add-routing`

- 时间：1 周
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手）

- [x] 0. 对照本地目录，列出已有模块：`docs/decision-model.md`、`server/ask-routing.ts`、`local-routing.ts`、`room-routing-members.ts`、`server/chief-of-staff.ts`、`server/tickets/classifier.ts`、`server/tickets/engine.ts`。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 MVP2b 已完成并推送（最新提交 `786516d`）：四层审批、飞书卡片回调、租户 Vault 替身 Token、双口径预算都已实现，本 change 不改审批。
- [x] 0. 确认 MVP2a 已完成：`TicketEngine` 和确定性分类器都已实现，Router 直接调用，不要重写。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：`openspec new change add-routing`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [x] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好，核对一遍本地目录名和函数名，错的改过来。
- [x] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：门口 Jev（复用，不新写）

- [x] 4. 门口 Jev：小模型，几百毫秒，派给哪个 Manager Bot，不确定回落到 lead bot，不做工单。先用固定规则 + 小模型，不做复杂模型选择。
- [x] 5. 飞书群聊接入：只响应 @ 机器人，不监听全部群消息。补开群消息权限（MVP1 只开了私聊）。

## 第 3 步：里面 Router

- [x] 6. 里面 Router：判断是不是新活，是新活生成 Ticket（复用 MVP2a `TicketEngine`），派给采购 / 下单 / 跟单 Bot。闲聊不生成 Ticket。
- [x] 7. Specialist 不直接回群：只能通过 Manager Bot 回，转手上限 `max_hops = 4`，超了交回给人。
- [x] 8. 防循环：按发送者 ID 过滤，Bot 自己发的消息不会再触发路由。

## 第 4 步：测 + 归档

- [x] 9. 建 `evals/` 样例集：30–50 条，覆盖查库存、跟工厂、下单、查价格、查物流、闲聊、模糊消息。目标：误派率 < 5%、回落率 < 20%。
- [x] 10. 按 specs 一条一条测，不要只测 happy path，也要测坏情况（见 specs/routing/spec.md）。
- [x] 11. 审计 + 归档：`openspec validate --all --strict --no-interactive` 通过，`openspec archive add-routing`，再推到 GitHub。
