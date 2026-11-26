# Tasks: MVP2a 工单 `add-ticket`

- 时间：1 周左右（MVP2 共 1–2 周，2a / 2b 各约一半）
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手）

- [x] 0. 对照本地目录，列出已有模块：`server/app-triggers.ts`、`server/bot-automations.ts`、`server/routine-*.ts`、`routine-run-gate.ts`、`routine-event-receipts.ts`、`routine-recovery.ts`。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 MVP1 网关现状：飞书事件的 `event_id` 有没有存下来？白名单在哪一层？去重键能复用吗？
- [x] 0. 确认 MVP1.5 已批 R1：Ticket 存在控制面（开发阶段是 harness 独立 SQLite，通过接口访问），Mandate 带哈希，agent 只能读。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：`openspec new change add-ticket`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [x] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好，核对一遍本地目录名和函数名，错的改过来。
- [x] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：接 Trigger（复用，不新写）

- [x] 4. 接 Trigger：把飞书消息和业务事件接入现有 Trigger（`server/app-triggers.ts`、`server/bot-automations.ts`、`server/routine-*.ts`），不要新写一个 Trigger。事件来源：飞书新消息、新订单、库存变化、定时巡检，全部先到 Trigger。
- [x] 5. 去重 + 鉴权：同一句话发两次，只生成一张 Ticket；不在白名单的，直接丢掉。复用 `routine-event-receipts.ts`（去重回执）和 `routine-run-gate.ts`（运行门控）。

## 第 3 步：生成 Ticket

- [x] 6. 生成 Ticket：字段 id、时间、来源、发起人、Mandate（不可变）、工具白名单、预算、状态、parent_id。Engine 是唯一写工单的人。
- [x] 7. Mandate 防篡改：字段目标、范围、工具白名单、预算上限、有效期、发起人、批准人；生成时计算内容哈希，存在控制面；agent 只能读带签名的只读副本，尝试修改被拒绝并有日志；修改 Mandate 等于新建一张 Ticket，`parent_id` 关联旧单，旧单状态改为 `superseded`。
- [x] 8. 收窄规则：普通对话（问答、闲聊、查询）不生成 Ticket，走会话直接回；只有副作用工作（写数据、发消息、花钱、长任务）才生成 Ticket；会话中途要做这类事时，再生成一张 Ticket。判断规则写死在代码里，不要让模型判断。
- [x] 9. 默认 observe：observe 只用在外部事件来源（新订单、库存变化、Webhook），先记录不执行；白名单用户私聊照常回复，不走 observe。
- [x] 10. Ticket 存储：开发阶段放在 harness 的独立 SQLite 文件里，通过接口访问；VM 内最多留一份只读副本。不要让 agent 直接读写这个文件。

## 第 4 步：测 + 归档

- [x] 11. 按 specs 一条一条测，不要只测 happy path，也要测坏情况（见 specs/ticket/spec.md）。
- [x] 12. 审计 + 归档：隔离验证与严格校验已通过，变更已归档至 `openspec/changes/archive/2026-11-26-add-ticket/`，生效规范在 `openspec/specs/ticket/spec.md`。
- [x] 13. 推送：本机修改已提交并推送到 `origin/main`，提交 `7d978dfa1`、`5f39b0c69`；文件长度检查、类型检查和 OpenSpec 校验均通过。
