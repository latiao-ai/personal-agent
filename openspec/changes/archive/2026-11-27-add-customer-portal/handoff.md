# Handoff: 客户 Web 门户 + 管理后台 `add-customer-portal`

- Change: `add-customer-portal`
- 阶段：MVP6 之后的第一批后续 change 之一；和 `add-credential-proxy` 并列，都是 MVP6 开工前 / 开工后要补的缺口
- 时间：2–3 周（估计值，本地 agent 按第 0 步盘点后确认）
- 状态：**已完成并验证通过，准备归档推送**（维护者于 2026-11-27 批准 R1 并授权自动测试、归档与推送）
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

## 复用盘点（第 0 步，已完成）

| 模块 / 能力 | 现状 | 处置（已有 / 要改 / 要新建） | 说明 |
|---|---|---|---|
| 前端总入口 `src/main.tsx` | 已有 `PAGES_WITHOUT_THE_APP` 独立页面分发 | **要改** | 增加 `/portal`（客户 Web 门户）与 `/admin`（管理后台）懒加载路由，不影响原有桌面 App |
| 前端样式与设计系统 `src/styles.css`、`DESIGN.md`、`qrcode.react`、`lucide-react` | 已有完整语义 token、响应式样式与二维码/图标库 | **已有（复用）** | 客户门户与管理后台严格复用语义 token 与设计规范 |
| 客户 Web 门户（6 页）与管理后台前端 | 无租户门户/管理后台页面 | **要新建** | 新建 `src/portal/CustomerPortalApp.tsx`（扫码登录 + 6 页）与 `src/admin/AdminConsoleApp.tsx`（独立登录 + 跨租户管理） |
| `/api/tickets`（`server/tickets/engine.ts`、`server/routes/tickets.ts`） | 已有控制面工单引擎与 SQLite 存储 | **已有（复用+门户隔离包装）** | 客户门户接口按登录态 `tenantId` 对应的 `openIds` 强过滤，跨租户访问返回 403 |
| `/api/approvals`（`server/approvals/store.ts`、`server/approvals/engine.ts`） | 已有 `transitionPendingCard` 原子条件更新、双口径预算与审计日志 | **要改（最小增量）** | 为审批卡片和审计增加 `channel: "feishu" \| "web"` 及状态变更广播事件，复用原子条件更新实现双通道审批 |
| `/api/routing`（`server/routing/`） | MVP3 已完成 | **已有（复用，不动）** | 保持原有群聊路由不变 |
| `/api/patrol`（`server/patrol/engine.ts`、`server/routes/patrol.ts`） | 已有只读巡检、日报与独立账本，无租户巡检频率/日报时间配置表 | **已有 + 要新建配置** | 在 `server/portal/store.ts` 持久化各租户巡检频率、日报时间与定时任务开关，修改落控制面并记审计 |
| `/api/memory-skill`（`server/memory-skill/engine.ts`、`skill-manager.ts`） | 已有三层记忆、技能列表与核心技能 SHA-256 锁 | **已有（复用+权限拦截）** | 客户门户只读展示，直接调接口改核心技能返回 403；管理后台改核心技能哈希须经审批流 + 二次确认 |
| `/api/isolation`（`server/isolation/engine.ts`、`store.ts`） | MVP6 已完成并推送（`55214e7`），含 VM 状态、多 Bot 档案、计量、销户先导出再删除 | **已有（直接复用）** | 管理后台直接复用 `IsolationEngine` 查全部租户 VM、开通租户、执行销户导出与删除 |
| 客户飞书扫码登录 + 租户角色 + 管理员账号体系 | 原有仅桌面配对与邮箱登录 | **要新建** | 新建 `shared/portal.ts`、`server/portal/{store.ts,engine.ts,host.ts}`、`server/routes/portal.ts`，并在 `server/index.ts` 挂载公开认证与独立鉴权路由 |

## 批准

- 批准：R1，2026-11-27，维护者在对话中明确批准按 `tasks.md` 实施、自行完成测试并在测试全通过后提交推送，范围只限 proposal 里写的，不扩范围。
- 要扩大范围，必须出 R2，重新批。不能在改代码的时候偷偷扩。尤其注意：不要在本 change 里做完整 Ontology 页面，不要在本 change 里做 Bot 代填账号密码，不要把客户 Web 做成能改核心技能的入口。

## 做到哪了

- tasks.md 第 0–5 步全部完成并打勾。
- 新增/修改文件：
  - `shared/portal.ts`、`shared/approvals.ts`（双通道审批与门户/后台契约）
  - `server/approvals/store.ts`、`server/approvals/engine.ts`、`server/routes/approvals.ts`（双通道渠道标记、原子条件更新与状态事件广播）
  - `server/portal/store.ts`、`server/portal/engine.ts`、`server/portal/host.ts`、`server/routes/portal.ts`（客户飞书扫码登录、租户与角色强制隔离、6 页控制面接口、SSE 双通道同步、独立管理后台与高危操作审批）
  - `server/index.ts`（接入 `createPortalHost` 与 `/api/portal/*`、`/api/admin/*` 自鉴权路由）
  - `src/portal/CustomerPortalApp.tsx`、`src/admin/AdminConsoleApp.tsx`、`src/main.tsx`（响应式客户 Web 门户 6 页与独立管理后台前端）
  - `server/portal/portal.test.ts`（全量正反例测试）
- 验证证据：
  - Vitest：`server/portal/portal.test.ts` + MVP2a–MVP6 全部回归 **60/60 通过**（7 个测试文件全绿）。
  - 静态检查：`oxlint --deny-warnings` **0 警告 0 错误**；前端 `tsc -b` **0 错误**；`vite build` 生产构建通过（15.27s）。
  - 隔离端到端验证：在临时目录 `omb-portal-e2e-*` 启动隔离 HTTP 控制面服务器，实测管理员登录/开通租户、飞书扫码登录、跨租户 403、普通成员改预算 403、客户访问管理后台 403、SSE 实时双通道审批失效、核心技能锁定（客户 403 / 管理直改 403 / 审批+二次确认更新哈希 200）及销户先导出再删除，**6/6 场景全通过**。

## 卡在哪

- 无。

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
