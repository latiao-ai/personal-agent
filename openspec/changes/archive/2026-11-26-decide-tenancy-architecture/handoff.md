# Handoff: MVP1.5 架构决策 `decide-tenancy-architecture`

- Change: `decide-tenancy-architecture`
- 阶段：MVP1.5，MVP1 收尾后、MVP2 开始前
- 时间：2–3 天，只写文档，不改代码
- 状态：**R1 已批准；文档已归档，维护者已要求将本机全部修改提交并推送，发布进行中**
- 授权出处：本会话用户于 2026-11-26 指示“照着这个 tasks.md 文件，把任务不断完成”；按任务定义登记为 R1，仅限六项决策及文档，不扩围。
- 分支与基线：`main`，`92eb6457ff128d4bbbd622ab9e4b42da4200f473`；工作区另有未提交变更，本 change 不包含它们。
- 最近验证：`openspec validate --all --strict --no-interactive` 通过；`openspec status --change decide-tenancy-architecture --json` 可见。
- 发布授权：用户于 2026-11-26 明确要求将本机所有修改提交并推送到 GitHub；按该要求一并发布本 change 与同工作区其他变更。
- 下一步：推送本机全部变更至 `origin/main`。
- 依据：提案记录的 `~/workspace/personal-agent-mvp1-upgrade-roadmap.md` 在当前环境不可读取；当前范围与任务来自仓库内提案及用户本会话授权。

## 已确认的基线

- 代码基线：`5987204e3`
- 工作基线：`92eb6457ff128d4bbbd622ab9e4b42da4200f473`（`bootstrap-dev-workspace` 文档与配置，11 个文件，334 行增 / 22 行删，无业务代码改动）
- 本地路径：`/Users/latiao/OpenMausBot`
- 远程仓库：https://github.com/latiao-ai/personal-agent
- MVP0：已跑通，等 `bootstrap-dev-workspace` 最终审计。
- MVP1：已到 R2 收尾，私聊收发、白名单拒绝、重启不重复回、单 WebSocket 自动重连已验证；剩下：另一个白名单外账号的现场拒绝验收、服务器网络中断恢复验收、维护者最终审计。

## 已确认的结论（2026-11-26）

1. 租户粒度：一用户一台 microVM，同一用户的多个 Bot 共享这台 VM；企业层只在控制面做。
2. 控制面 / VM 边界：VM 外放 IM 网关、租户与身份、Ticket 与 Mandate 存储、审批记录、预算计数、Vault、LLM 转发代理、审计日志；VM 内放 OpenMausBot 运行时、会话、记忆、技能、浏览器和工作文件。原则：凡是用来约束 agent 的东西，都不能放在 agent 能写的地方。
3. 引擎：第三方中转站 API Key（OpenAI / Anthropic 兼容端点），总 Key 放控制面 LLM 代理层，不进用户 VM。
4. `enterprise/`：先保留继续用；对外托管 / SaaS / 白标必须向 Milind Soni 取得商业/合作授权，上线前二选一：买授权，或迁走后删除。
5. 技能锁：只锁核心技能（采购、付款、删数据），其他技能不分档、不审批。用户 2026-11-26 明确：分档更麻烦，不要分档；小改也要重新批不现实。

## 复用盘点（第 0 步）

| 领域 / 路径 | 已有 | 要改 | 要新建 |
|---|---|---|---|
| `server/local-vm-*.ts` | 有本机容器 VM 的 availability、container box、lease、inventory、profiles、seat pool、settings、stop reason；支持本机容器生命周期与 Bot/会话占用管理 | MVP6 需把本机容器抽象替换或扩展为按用户的 microVM 生命周期、持久盘、配额与宿主机调度；不能直接复用为 microVM 调度器 | 云端 microVM provider/host scheduler、租户级持久盘迁移与快照恢复 |
| `server/contracts.ts` | 有 harness 内部 provider/driver、运行时事件及 turn 等类型契约 | 若控制面与 VM runtime 需正式协议，应增设版本化 HTTP/API 契约，不把本文件误当网络接口 | 控制面与 VM 间的认证、租户路由、Ticket/Mandate 和结果回传协议 |
| `docs/custom-engines.md` | 支持 OpenAI-compatible / Anthropic-compatible provider 配置；API key 从 OMB 配置环境读取，文件虽为 0600，环境值仍明文 | 托管路径改为只向 VM 注入租户限定的内部虚拟 Key，并将 provider 请求路由到代理 | 控制面 LLM 代理、虚拟 Key 签发/撤销、用量账本、预算熔断和供应商切换 |
| `docs/approval-levels.md` | 记录当前 bot/thread 执行审批级别和工具授权语义 | MVP2 需与控制面 Ticket/Mandate、用户身份审批记录明确区分并集成 | 面向租户的 Ticket/审批记录持久化及签名 Mandate，不以 VM 内审批状态作为权威 |
| `enterprise/` | `whitelabel` 品牌配置；`admin` hosted workspace sign-in adapter；`budgets` 授权 `server/spend.ts` 的 workspace 月度总额限制；`billing` 授权 Usage 历史/CSV 的 billable 价格列；`sso` 仍 planned。身份控制台不在仓库 | 上线前二选一：购买书面托管/合作授权，或迁出确实要用的能力 | 若选择自研迁移，按实际产品需要重建能力，再删除整个目录；不得绕许可校验 |
| MVP1 飞书网关（`scripts/feishu_gateway.py`、`scripts/feishu_relay.py`） | 独立 Python 进程经 localhost HTTP 调用 harness `/api/...`，有唯一进程锁、白名单路由与 SQLite 投递账本；不直接耦合 harness 内部函数 | MVP6 将部署位置和身份解析迁至 VM 外控制面，并改为租户 / VM 路由 | 面向正式托管的网关部署、租户目录和控制面到 VM 的安全投递通道 |

结论：MVP1 网关已经与 harness 松耦合并只经 HTTP API 投递；当前为同机回环连接，尚不是控制面服务。MVP6 搬离 VM 仍是独立的部署与路由工作，不在本 change 实现。

## 批准记录

- 批准：R1，2026-11-26，可以做，范围只限本文档的 6 个决策与文档，不扩范围。
- 出处：用户本会话原话“照着这个tasks.md文件，把任务不断完成，自己去检查分析，我只负责查看最终结果”。按该请求和任务第 7 项登记为 R1 授权。
- 扩大范围必须出 R2 并重新批准；本轮未改业务代码。

## 验证与交接

- `openspec validate --all --strict --no-interactive`：通过，退出码 0；3 个 change 通过、0 个错误或警告（2026-11-26）。第一次运行发现规范文件路径不符合 OpenSpec 要求，已移动到 `specs/tenancy-architecture/spec.md`；随后去掉规范首个标题前的不归档说明并复验通过。
- `openspec status --change decide-tenancy-architecture --json`：确认 change 在仓库中，完整且有 proposal/spec/design/tasks。
- 已归档：`openspec/changes/archive/2026-11-26-decide-tenancy-architecture/`；生效规范位于 `openspec/specs/tenancy-architecture/spec.md`。
- 本次发布按用户要求覆盖工作区全部变更，不限于本 change。
- 推送前运行 `openspec validate --all --strict --no-interactive`，并核对提交文件列表和凭据脱敏。
- 下一项 MVP2a `add-ticket` 应另开 change，开始前按工作区要求复用盘点 `server/app-triggers.ts`、`routine-*.ts`、`permission-proxy.ts` 与 `docs/approval-levels.md`。
