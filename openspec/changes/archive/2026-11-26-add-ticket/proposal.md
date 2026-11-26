# Change: add-ticket（工单，MVP2a）

> 状态：proposal 草稿，待你批 R1 后动手。
> 对应改造方案 MVP2a（`~/workspace/personal-agent-mvp1-upgrade-roadmap.md` 2026-11-26 新版）。
> 依据：MVP1.5 `decide-tenancy-architecture`（已批 R1，2026-11-26 15:20）。
> 底座：OpenMausBot，本地 `/Users/latiao/OpenMausBot`；代码基线 `5987204e3`，
> 工作基线 `92eb6457ff128d4bbbd622ab9e4b42da4200f473`。

## 为什么改

- 现在没有工单：飞书发一句话，Bot 直接就做了，做了什么、花了多少钱、谁让做的，事后查不到。
- MVP1 只通了“私聊能收能回”，下一步要能审计：每件会产生副作用的工作，先变成一张 Ticket，有 id、有目标、有预算、有状态，做完能查，做错能回滚。
- 没有 Ticket，MVP2b 的审批、MVP4 的巡检、MVP6 的隔离都没有落点：审批不知道批哪张单，巡检不知道升级成哪张单。

## 改什么（范围）

只加一层 Ticket，不做审批、不做执行：

1. **先复用，再新建**：不新写一个 Trigger。OpenMausBot 已有完整的触发和执行链路（`server/app-triggers.ts`、`server/bot-automations.ts`、`server/routine-*.ts`，其中运行门控、去重回执、恢复在 `routine-run-gate.ts`、`routine-event-receipts.ts`、`routine-recovery.ts`）。本 change 是把飞书消息和业务事件接入现有 Trigger，Ticket 是在这条链路上新加的一层。
2. **只给副作用工作生成 Ticket**：普通对话（问答、闲聊、查询）仍走会话，不生成 Ticket。**只有会产生副作用的工作**（写数据、发消息、花钱、长任务）才生成 Ticket。会话中途要做这类事时，再生成一张 Ticket。
3. **Ticket 字段**：id、时间、来源、发起人、Mandate（不可变）、工具白名单、预算、状态。
4. **Mandate 不可变 + 防篡改**：字段是目标、范围、工具白名单、预算上限、有效期、发起人、批准人。生成时计算内容哈希，存在控制面。agent 只能读取，不能修改。修改 Mandate 等于新建一张 Ticket，用 `parent_id` 关联旧单，旧单状态改为 `superseded`。
5. **默认 observe 只用在外部事件**：observe 只用在**外部事件来源**（新订单、库存变化、Webhook），先记录，不执行。白名单用户的私聊照常回复，不走 observe，否则 MVP1 就退化了。
6. **去重 + 鉴权**：同一句话发两次，只生成一张 Ticket；不在白名单的，直接丢掉，不生成 Ticket。
7. **Ticket 存在控制面**：按 MVP1.5 的边界，Ticket 不存在 VM 里。开发阶段可以先放在 harness 的独立 SQLite 文件里，但要通过接口访问，以后好搬到控制面。

## 不动什么（边界）

- 不做审批卡片（批准 / 拒绝回调）：那是 MVP2b `add-approval` 的事。本 change 只生成 Ticket，不决定“能不能执行”。
- 不做分层审批、不做 Vault、不做预算熔断：那是 MVP2b 的事。本 change 只在 Ticket 里记预算上限，不执行熔断。
- 不做路由 / Jev 分流：那是 MVP3 的事。本 change 不决定派给哪个 Bot，只决定“这件事变成哪张 Ticket”。
- 不做只读巡检：那是 MVP4 的事。本 change 只接外部事件进 Trigger，不写巡检逻辑。
- 不做记忆与技能：那是 MVP5 的事。
- 不改 OpenMausBot 核心的 bot 调度、记忆、harness 服务；不删模块。
- 不接钉钉 / 企业微信；先只做飞书。

## 验收标准

- [ ] 发一句话（副作用工作），能生成一张 Ticket，id 唯一，字段全。
- [ ] 同一句话发两次，只生成一张 Ticket。
- [ ] 普通对话（问答、闲聊、查询）不生成 Ticket，照常回复。
- [ ] 白名单用户私聊照常回复，不走 observe；外部事件（新订单、库存变化、Webhook）默认 observe，只记录不执行。
- [ ] Mandate 改了，旧 Ticket 作废（状态 `superseded`），新 Ticket 重新审批（`parent_id` 关联旧单）。
- [ ] agent 尝试通过工具修改 Mandate，被拒绝并有日志。
- [ ] `openspec validate --all --strict --no-interactive` 通过；`tasks.md` 全勾完；`handoff.md` 写清楚。

## 风险

- 把所有消息都变 Ticket，会多走一层，延迟和成本都上升。防法：本 change 已收窄，只给副作用工作生成 Ticket，普通对话不生成。
- 新写一个 Trigger，和现有的 `routine-*.ts` 重复。防法：第 0 步先盘点，2a-4 是“接入现有 Trigger”，不是新写。
- Ticket 存在 VM 里，agent 能改。防法：Ticket 存在控制面（开发阶段是 harness 的独立 SQLite，通过接口访问），Mandate 带哈希，agent 只能读。
- 隔离环境验证：凡是涉及写入的验证，只能在隔离测试环境中做，不能用正在运行的应用或真实数据。
