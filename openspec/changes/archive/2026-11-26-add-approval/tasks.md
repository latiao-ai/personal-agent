# Tasks: MVP2b 审批 `add-approval`

- 时间：1 周左右（MVP2 共 1–2 周，2a / 2b 各约一半）
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手）

- [x] 0. 对照本地目录，列出已有模块：`docs/approval-levels.md`、`server/permission-proxy.ts`、`auto-approve.ts`、`always-allow.ts`、`decision-log.ts`、`spend.ts`、`harness-budget.ts`、`cloud-secrets.ts`。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 MVP2a 已完成：Ticket 字段、Mandate 不可变、去重、observe 都已实现，本 change 不改 Ticket 生成逻辑。
- [x] 0. 确认 MVP1.5 已批 R1：审批记录、Vault、预算计数都在控制面；预算嵌在替身 token 里。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：`openspec new change add-approval`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [x] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好，核对一遍本地目录名和函数名，错的改过来。
- [x] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：分层审批（硬规则在前）

- [x] 4. 分层审批：1 直接做（只读）；2 智能审批（一般写操作，先让评审模型看）；3 先问人（花钱 / 下单 / 付款 / 删数据 / 对外发消息，必须弹卡片）；4 交回给人（超预算 / 不在白名单 / 评审判有风险）。分层顺序固定为“代码规则 → 评审模型 → 人”。
- [x] 5. 评审模型规则：只能把风险往上调，不能往下调；超时、报错或输出无法解析时一律按“先问人”处理；不能让评审模型决定是否放行花钱类动作。

## 第 3 步：审批卡片（飞书）

- [x] 6. 审批卡片：Allow once / Always allow / Deny，卡片上写清楚做什么、花多少钱、给谁、有什么风险、对应哪张 Ticket。补上飞书交互卡片的回调权限（`card.action.trigger`，MVP1 没开）。
- [x] 7. 卡片校验：校验点击人的 `open_id` 必须是这张 Ticket 的批准人，非批准人点击无效并有日志；同一张卡片重复点击要幂等，只执行一次；卡片过期后点击无效。

## 第 4 步：凭据与预算

- [x] 8. 凭据 vault：真实凭据放 vault，Agent 只拿临时替身 token，用完失效；每个客户 vault 分开；Composio 的 OAuth 连接直接复用。自建业务系统的完整出口代理注入，拆成单独的 change `add-credential-proxy`，本 change 不做。
- [x] 9. 预算上限：单笔 / 日 / 月上限，超了直接停，不问模型。区分“模型 token 花费”和“业务花费（下单金额）”，两者分别设上限。现有 `spend.ts` 只管前者。
- [x] 10. 审计记录：谁批的、批了什么、什么时候批的、花了多少钱，落库，能查到。审计记录存在控制面。

## 第 5 步：测 + 归档

- [x] 11. 按 specs 一条一条测，不要只测 happy path，也要测坏情况（见 specs/approval/spec.md）。
- [x] 12. 审计 + 归档：`openspec validate --all --strict --no-interactive` 通过，`openspec archive add-approval`，再推到 GitHub。
