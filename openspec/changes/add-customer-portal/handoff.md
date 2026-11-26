# Handoff: 客户 Web 门户 + 管理后台 `add-customer-portal`

- Change: `add-customer-portal`
- 阶段：MVP6 之后的第一批后续 change 之一；和 `add-credential-proxy` 并列，都是 MVP6 开工前 / 开工后要补的缺口
- 时间：2–3 周（估计值，本地 agent 按第 0 步盘点后确认）
- 状态：**待 R1 批准**（本文档包是草稿，用户在聊天里回“可以做”或在下方写批准行，即为 R1）
- 依据：2026-11-26 晚用户在聊天里定的三层前端——飞书群是主入口，客户 Web 是 OpenMausBot 前端改成的审计/自助页，管理后台是另一套看所有租户的页面；MVP6 只写了“Web 后台”一句话，没有单独设计。

## 背景（2026-11-26 晚，聊天里定下来的）

- 用户说：客户主要是在飞书群里，Web 页面也可以是现在的 OpenMausBot 前端页面，但是还要偏审计一点，可以让用户修改他的某些 Bot、看到一些消耗或者定时任务什么的。而管理有自己的后台页面，可以看到不同用户的后台信息。
- 之前 MVP 里缺了中间那一层：飞书群有了（MVP1–MVP3），控制面 API 有了（`/api/tickets`、`/api/approvals`、`/api/routing`、`/api/patrol`、`/api/memory-skill`），但客户 Web 和管理后台都没有单独设计。
- 同一个晚上用户还问了三件事，都和本 change 有关，都写进来了：
  - Hermes 一个网关管所有会话，手机、iPad、电脑是一份——本 change 的客户 Web 按这个思路，会话在控制面。
  - 审批卡飞书和网页都弹，用户在任何一个地方点确定都可以——本 change 第 3.5 节，双通道审批，真相只有控制面一条记录。
  - 客户登录系统是不是设计好了——本 change 第 3.1 节，客户登录第一版只做飞书扫码，不设密码；`add-credential-proxy` 里“客户登录放到 MVP6 之后再做”的那句话，指的就是本 change。

## 已确认的基线

- 代码基线：`5987204e3`
- 工作基线：`92eb6457ff128d4bbbd622ab9e4b42da4200f473`
- 最新 HEAD：`55214e7`（2026-11-26，MVP6 `add-isolation-deploy` 已完成）
- 本地路径：`/Users/latiao/OpenMausBot`
- 远程仓库：https://github.com/latiao-ai/personal-agent
- MVP2a–MVP5：已完成并归档推送。本 change 复用它们的 API 和存储，不重做 Ticket、审批、巡检、记忆。
- MVP6：文件已到，待 R1。本 change 可以先做，不等 MVP6；但管理后台的 VM 状态页要和 MVP6 的隔离规则对上。
- `add-credential-proxy`：文件已到，待 R1。凭据的事走那个 change，本 change 不碰真凭证。

## 复用盘点（第 0 步，在本地核对后填）

- [ ] OpenMausBot 前端入口 / 路由 / Bot 列表 / 聊天 / 审批卡片 / 设置页：已有 / 要改 / 要新建？
- [ ] `/api/tickets`、`/api/approvals`、`/api/routing`、`/api/patrol`、`/api/memory-skill`：已有 / 要改 / 要新建？（要加 `tenant_id` 过滤和分页吗？）
- [ ] MVP2b `server/approvals/store.ts` 原子条件更新：已有 / 要改 / 要新建？（双通道能不能直接复用？）
- [ ] MVP1 飞书 `open_id` 白名单：已有 / 要改 / 要新建？（扫码登录的 `open_id` 是不是同一套？）
- [ ] MVP4 巡检配置、MVP2b 双口径预算：已有 / 要改 / 要新建？
- [ ] MVP6 的 VM 状态：已有 / 要改 / 要新建？（管理后台要展示的字段控制面现在有没有？）
- [ ] 飞书扫码登录能力：已有 / 要改 / 要新建？

## 批准

- 批准：R1，待用户确认。用户在聊天里回“可以做”，或在下方写：
  ```
  批准：R1，2026-11-26，可以做，范围只限 proposal 里写的，不扩范围。
  ```
- 要扩大范围，必须出 R2，重新批。不能在改代码的时候偷偷扩。尤其注意：不要在本 change 里做完整 Ontology 页面，不要在本 change 里做 Bot 代填账号密码，不要把客户 Web 做成能改核心技能的入口。

## 做到哪了

- tasks.md 第 0–1 步：文档包已写好（proposal / design / tasks / handoff / specs/customer-portal.md），待用户复制到本地 / 合并 PR。
- tasks.md 第 2–5 步：未开始，等 R1 批了再做。

## 卡在哪

- 无。等 R1。另：本 change 的 PR 需要 GitHub 连接后才能从云端提交（见 README），如果 GitHub 还没连，先连 GitHub、选 `latiao-ai/personal-agent` 这个仓库，再推 PR。

## 下一步

1. 用户批 R1（回“可以做”）。
2. 在 Mac 上（如果走 PR 合并，就不用手动复制，直接合并后拉下来）：
   ```bash
   cd /Users/latiao/OpenMausBot
   openspec new change add-customer-portal
   ```
   把本包的 5 个文件复制到刚生成的同名目录里，**文件要和隐藏的 `.openspec.yaml` 在同一层，不要嵌套一层多余的文件夹**。
3. 按 tasks.md 第 0 步先做复用盘点，填上面“复用盘点”一节，确认哪些是复用、哪些是新建，再写正式代码。
4. 按 specs/customer-portal.md 一条一条测，在隔离测试环境中测，尤其要测跨租户调接口、双通道同时点、普通成员改预算、直接调接口改核心技能这四种坏情况。
5. `openspec validate --all --strict --no-interactive` 通过后，`openspec archive add-customer-portal`，再推到 GitHub。
6. 本 change 完成后，再开后续 change：客户登录 Web 后台已在本 change 里做了第一版（飞书扫码），后续要扩密码登录或企业 SSO 再出 R2；价格 / 物流 / 供应商回复 / 爆品信号 4 类巡检数据源、全量 Ontology，仍是后续 change。
