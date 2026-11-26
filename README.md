# 客户 Web 门户 + 管理后台 change：`add-customer-portal`

日期：2026-11-26（晚）
依据：2026-11-26 晚用户在聊天里定的三层前端——飞书群是主入口，客户 Web 是 OpenMausBot 前端改成的审计/自助页，管理后台是另一套看所有租户的页面；MVP6 只写了“Web 后台”一句话，没有单独设计
前置：MVP2a–MVP5 已完成并推送（最新 HEAD `55214e7`（MVP6 已完成））；MVP6 已完成并推送（`55214e7`）；`add-credential-proxy` 文件已到，待 R1
时间：2–3 周（估计值，本地 agent 按第 0 步盘点后确认）

## 为什么要做这个 change

客户主入口是飞书群，这个有了；控制面 API 有了，但客户 Web 和管理后台都没有单独设计。客户想查账、改巡检时间、看消耗，只能在群里问 Bot；运营想看所有客户的状态，只能一个一个查 API。

## 最关键的 3 条（别做错）

1. **租户隔离在服务端，不在前端**：每个接口服务端强制带 `tenant_id` 查，跨租户直接 403。前端藏起来不算隔离，要测“直接调接口拿别人数据”。
2. **审批真相只有一条记录**：飞书卡和网页待办都是同一条审批记录的显示，一边点了，另一边立刻失效；两边同时点，只有一个生效（复用 MVP2b 的原子条件更新）。
3. **客户能改的和不能改的分清**：能改巡检时间、预算上限、Bot 开关、定时任务、审批人名单；不能改核心技能、真凭证、别人数据、控制面规则。核心技能直接调接口改也要 403。

## 三层前端

- **飞书群（主入口）**：客户说话、看日报、点审批卡，MVP1–MVP3 已有，不变。
- **客户 Web 门户（OpenMausBot 前端改）**：6 页——Bot 列表、Ticket 与审批、消耗（token / 业务两本账）、定时任务、记忆与技能（只读）、设置。手机、iPad、电脑都能开，会话在控制面。
- **管理后台（另一套页面）**：能看所有客户列表、VM 状态、消耗账单、审批审计；销户先导出再删除；改核心技能哈希要走审批。

客户登录第一版只做飞书扫码，不设密码，身份就是 MVP1 的 `open_id` 映射到 `tenant_id`。

## 怎么用（在 Mac 上）

```bash
cd /Users/latiao/OpenMausBot
openspec new change add-customer-portal
# 把本目录 openspec/changes/add-customer-portal/ 下的 5 个文件，
# 复制到本地刚生成的同名 change 目录里
# 注意：文件要和隐藏的 .openspec.yaml 在同一层，不要嵌套一层多余的文件夹
openspec list
```

然后按 `tasks.md` 一项一项做，做完一项勾一项；全部通过后：

```bash
openspec validate --all --strict --no-interactive
openspec archive add-customer-portal
```

## 如果走 PR（用户 2026-11-26 晚要求）

用户要求直接在云端给 GitHub 提 PR，合并后本地智能体按 `tasks.md` 运行测试。

- 仓库：https://github.com/latiao-ai/personal-agent，分支：从 `main`（HEAD `55214e7`）切 `add-customer-portal`
- PR 里只有这 5 个新文件 + README，不改现有代码、不删文件
- 云端 GitHub 需要先连接：点 GitHub 连接授权，再选 `latiao-ai/personal-agent` 这个仓库，授权后才能推 PR。没连之前，云端推不了 PR，先用上面“怎么用”的手动复制方式也行。
- 合并后在 Mac 上拉下来，`openspec new change add-customer-portal`，文件已经在 `openspec/changes/add-customer-portal/` 里了，直接按 `tasks.md` 第 0 步做复用盘点。

## 文件清单

```
openspec/changes/add-customer-portal/
  proposal.md         # 为什么做、三层前端、客户能改/不能改、双通道审批、管理后台
  design.md           # 怎么做：架构图、飞书扫码登录、客户版 6 页、双通道、租户隔离、管理后台
  specs/customer-portal.md  # 可测验收标准，7 组，每条都能实际演示
  tasks.md            # 19 步，2–3 周，第 0 步是复用盘点
  handoff.md          # 背景、基线、复用盘点、批准、下一步，**目前是待 R1**
```

## 不做

- 不改飞书群的交互，不改四层审批的规则，不改 MVP5 的核心技能锁。
- 不做 Bot 代填账号密码：凭据的事走 `add-credential-proxy`。
- 不做完整 Ontology 页面：记忆和技能页只展示 MVP4 的最小字段和 MVP5 的偏好/规则。
- 不做密码登录：客户登录第一版只做飞书扫码，密码登录或企业 SSO 要扩必须出 R2。
