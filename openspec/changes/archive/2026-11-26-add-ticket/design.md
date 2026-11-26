# Design: add-ticket（工单，MVP2a）

- Change: `add-ticket`
- 阶段：MVP2a，MVP1.5 之后、MVP2b 之前
- 时间：1 周左右（MVP2 共 1–2 周，2a / 2b 各约一半；复用盘点后以 tasks.md 为准）

## 1. 架构图（文字版）

```
飞书私聊（白名单用户）
  │ 普通对话：问答 / 闲聊 / 查询
  │   → 不生成 Ticket，走会话直接回
  │
  │ 副作用工作：写数据 / 发消息 / 花钱 / 长任务
  │   → Trigger → Eval → Ticket
  ▼
外部事件：新订单 / 库存变化 / Webhook / 定时巡检
  │   → Trigger → Eval → Ticket（默认 observe，只记录不执行）
  ▼
┌──────────────────────────────────────────────┐
│  控制面（开发阶段：harness 的独立 SQLite，      │
│  通过接口访问，以后搬到控制面）                  │
│                                              │
│  Ticket 存储：id、时间、来源、发起人、            │
│  Mandate（不可变 + 内容哈希）、工具白名单、       │
│  预算、状态、parent_id                         │
│                                              │
│  Engine 是唯一写工单的人                        │
└──────────────────────────────────────────────┘
  │  VM 内的 agent 只能读带签名的 Mandate 只读副本
  │  尝试修改 → 拒绝 + 日志
  ▼
VM 内：OpenMausBot 运行时
  会话 / 工作记忆 / 浏览器和工作文件
  （执行在 MVP2b 审批之后才做，本 change 不执行）
```

**读图规则**：Trigger 是入口，Ticket 是落点，Engine 是唯一写工单的人。普通对话不进 Ticket，外部事件默认 observe，白名单私聊照常回复。

## 2. 借鉴谁

- **DeepSeek Super Agent**：Trigger → Eval → Ticket，Engine 是唯一写工单的人，默认 `observe`。
- **OpenMausBot 现有链路**：定时、Webhook、应用事件已有 `server/app-triggers.ts`、`server/bot-automations.ts`、`server/routine-*.ts`，运行门控、去重回执、恢复在 `routine-run-gate.ts`、`routine-event-receipts.ts`、`routine-recovery.ts`。本 change 是接入，不是重写。
- **MVP1.5 边界**：Ticket 存在控制面，Mandate 带签名，agent 只能读不能改。

## 3. 关键决定

### 3.1 什么时候生成 Ticket，什么时候不生成

| 输入 | 生成 Ticket？ | 原因 |
|---|---|---|
| 普通对话：问答、闲聊、查询 | 否 | 走会话直接回，不多走一层，否则延迟和成本上升 |
| 副作用工作：写数据、发消息、花钱、长任务 | 是 | 需要审计、需要预算、需要以后能回滚 |
| 会话中途要做副作用事 | 是（中途生成） | 会话先聊，聊到要做事时再生成一张 Ticket |
| 外部事件：新订单、库存变化、Webhook | 是，默认 observe | 先记录，不执行，确认是新活再转执行 |
| 白名单用户私聊 | 按上两行判断，不默认 observe | 否则用户发消息 Bot 不回，MVP1 就退化了 |
| 白名单外的人 | 否，直接丢掉 | 不生成 Ticket，不回复，有日志 |

判断规则写死在代码里，不要让模型判断“这句要不要生成 Ticket”。模型判断会漂移，今天生成、明天不生成。

### 3.2 Ticket 字段

| 字段 | 说明 |
|---|---|
| `id` | 唯一，全局不重复 |
| `created_at` | 生成时间 |
| `source` | 来源：飞书私聊 / 飞书群聊 / 新订单 / 库存变化 / Webhook / 定时巡检 |
| `initiator` | 发起人：`open_id` / 系统事件名 |
| `mandate` | 不可变，见 3.3 |
| `mandate_hash` | Mandate 内容哈希，生成时计算，存在控制面 |
| `tool_allowlist` | 工具白名单，这张 Ticket 只能调这些工具 |
| `budget` | 预算上限，分两项：模型 token 花费、业务花费（下单金额），见 3.5 |
| `status` | `observe` / `ready` / `executing` / `done` / `superseded` / `cancelled` |
| `parent_id` | 改 Mandate 时的新单关联旧单，首次生成时为空 |

状态流转：`observe` → `ready`（确认是新活）→ `executing`（MVP2b 审批通过后）→ `done`；`observe` / `ready` 可改为 `cancelled`；改 Mandate 时旧单改为 `superseded`。

本 change 只做到生成 Ticket 和 `observe` / `ready`，`executing` / `done` 的执行逻辑在 MVP2b 审批之后才接，本 change 不执行花钱、下单、发消息。

### 3.3 Mandate：不可变 + 防篡改

字段：

| 字段 | 说明 |
|---|---|
| `goal` | 目标，做什么 |
| `scope` | 范围，做到哪为止 |
| `tool_allowlist` | 工具白名单 |
| `budget_limit` | 预算上限（模型 token + 业务花费，分开记） |
| `valid_until` | 有效期，过期作废 |
| `initiator` | 发起人 |
| `approver` | 批准人（MVP2b 审批时填，本 change 可先为空） |

- 生成时计算内容哈希，存在控制面。
- agent 只能读取带签名的 Mandate 只读副本，不能修改。尝试通过工具修改 Mandate，权限代理拒绝并写日志。
- 修改 Mandate 等于新建一张 Ticket：新 Ticket 的 `parent_id` 指向旧单，旧单状态改为 `superseded`。不允许原地改 Mandate。

### 3.4 去重 + 鉴权

- 去重：同一事件只生成一张 Ticket。用 `event_id`（飞书事件有 `event_id`，Webhook 有事件 id）去重；没有 `event_id` 的，用“来源 + 发起人 + 内容哈希 + 时间窗口”去重。复用现有的 `routine-event-receipts.ts`（去重回执）和 `routine-run-gate.ts`（运行门控：上一次没跑完就跳过）。
- 鉴权：不在白名单的，直接丢掉，不生成 Ticket，不回复，有日志。白名单在 MVP1 已有，本 change 复用，不重写。
- 恢复：复用 `routine-recovery.ts`，进程重启后，已生成的 Ticket 不重复生成，已记录的 observe 不丢失。

### 3.5 预算口径

区分两项，分别记上限：

- 模型 token 花费：现有 `spend.ts` 只管这一项，本 change 在 Ticket 里记，不执行熔断。
- 业务花费（下单金额）：本 change 在 Ticket 里记，不执行熔断。熔断在 MVP2b `add-approval` 做。

### 3.6 Ticket 存在哪

- 按 MVP1.5：Ticket 存在控制面，不存在 VM 里。
- 开发阶段：先放在 harness 的独立 SQLite 文件里，但要**通过接口访问**，不要让 VM 内的 agent 直接读写这个文件。以后搬到控制面时，只改接口实现，不改调用方。
- VM 内最多留一份只读副本，agent 能改 VM 里的东西，不能改控制面的 Ticket。

## 4. 待核对（开始写代码之前，在本地核对这 5 项）

- [ ] `server/app-triggers.ts`、`server/bot-automations.ts`、`server/routine-*.ts` 的真实入口和函数名：飞书消息和业务事件从哪接进现有 Trigger？（建议 `grep -r "routine" server/`、`grep -r "app-triggers" server/`）
- [ ] `routine-run-gate.ts`、`routine-event-receipts.ts`、`routine-recovery.ts` 的去重和恢复逻辑：去重键是什么？恢复后会不会重复生成 Ticket？
- [ ] 现有 Trigger 有没有“副作用判断”？没有的话，3.1 的判断规则写在哪一层？（建议写在 Trigger 之后、Ticket 生成之前的一层，不要散在各处。）
- [ ] harness 的独立 SQLite 文件放哪？文件名、表结构、接口文件分别是什么？不要让 agent 直接读写这个文件。
- [ ] 飞书事件的 `event_id` 在 MVP1 的网关里有没有存下来？没有的话，去重键要改用“来源 + 发起人 + 内容哈希 + 时间窗口”。

## 5. 风险

- 模型判断要不要生成 Ticket，会漂移。防法：3.1 的规则写死在代码里。
- 新写一个 Trigger，和现有 `routine-*.ts` 重复。防法：第 0 步先盘点，2a-4 是接入现有 Trigger。
- Ticket 存在 VM 里，agent 能改。防法：Ticket 存在控制面（开发阶段是 harness 独立 SQLite，通过接口访问），Mandate 带哈希。
- 隔离环境验证：凡是涉及写入的验证，只能在隔离测试环境中做，不能用正在运行的应用或真实数据。
