# Tasks: 客户 Web 门户 + 管理后台 `add-customer-portal`

- 时间：2–3 周（估计值，本地 agent 按第 0 步盘点后确认）
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手，不要从零写）

- [ ] 0. 对照本地目录，列出已有模块：OpenMausBot 前端入口 / 路由 / Bot 列表 / 聊天 / 审批卡片 / 设置页、`/api/tickets`、`/api/approvals`、`/api/routing`、`/api/patrol`、`/api/memory-skill`、MVP2b `server/approvals/store.ts`、MVP1 飞书 `open_id` 白名单、MVP4 巡检配置、MVP2b 双口径预算。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [ ] 0. 确认 MVP2a–MVP5 已完成并推送（最新 HEAD `55214e7`（MVP6 已完成）），本 change 复用它们的 API 和存储，不重做 Ticket、审批、巡检、记忆。
- [ ] 0. 确认 MVP6 和 `add-credential-proxy` 的状态：如果 MVP6 还没批 R1，本 change 可以先做，不等 MVP6；但管理后台的 VM 状态页要和 MVP6 的隔离规则对上，不要写两套规则。客户登录走飞书扫码，不等 `add-credential-proxy` 的 Web 登录（那是另一条）。

## 第 1 步：新建 change 与写文档

- [ ] 1. 新建 change：`openspec new change add-customer-portal`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [ ] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好，核对一遍本地目录名、路由和函数名，错的改过来。
- [ ] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：客户登录 + 租户隔离

- [ ] 4. 客户登录：飞书扫码登录，扫码得到的 `open_id` 映射到 `tenant_id`；同一租户多人分管理员 / 普通成员两个角色，角色在服务端分。
- [ ] 5. 租户隔离：每个客户 Web 接口服务端强制带 `tenant_id` 查，跨租户直接 403；列表、搜索、导出、审计都要带过滤。
- [ ] 6. 测隔离：登录客户 A 的账号，直接调接口拿客户 B 的数据，必须 403；只在页面上看不到不算通过。

## 第 3 步：客户 Web 门户（6 页）

- [ ] 7. Bot 列表：复用现有前端 Bot 列表，只看自己租户；Bot 开 / 关，改完记审计。
- [ ] 8. Ticket 与审批：复用 `/api/tickets`、`/api/approvals`，展示谁批的、在哪边点的、什么时候、为什么。
- [ ] 9. 消耗：token / 业务两本账分开，日 / 月汇总和 MVP2b 双口径对得上；预算上限只有管理员能改。
- [ ] 10. 定时任务：巡检频率、日报时间、任务开 / 关；改完写控制面，页面显示“已生效 / 下次执行生效”。
- [ ] 11. 记忆与技能：只读展示 MVP5 的长期记忆和技能列表；核心技能没有修改入口，直接调接口改返回 403。
- [ ] 12. 设置：审批人名单，管理员才能改，改完记审计（改前改后）。

## 第 4 步：双通道审批

- [ ] 13. 双通道：审批同时推给飞书卡片和网页待办，同一条记录；一边点了，另一边推送失效变“已处理”。
- [ ] 14. 原子变迁：复用 MVP2b `server/approvals/store.ts` 的原子条件更新，待处理只能变一次；两边同时点只生效一个，审计只记一笔，记清在哪边点的。
- [ ] 15. 两边验身份：飞书验点击人 `open_id`，网页验登录人是不是同一审批人；身份对不上点不了。

## 第 5 步：管理后台 + 测 + 归档

- [ ] 16. 管理后台：单独的管理员登录，不走客户飞书扫码；能看所有客户列表、VM 状态、消耗账单、审批审计；销户先导出再删除，有删除记录；改核心技能哈希要走审批。
- [ ] 17. 按 specs 一条一条测，不要只测 happy path，也要测坏情况（见 specs/customer-portal.md），尤其要测跨租户调接口、双通道同时点、普通成员改预算、直接调接口改核心技能这四种。
- [ ] 18. 审计 + 归档：`openspec validate --all --strict --no-interactive` 通过，`openspec archive add-customer-portal`，再推到 GitHub。
