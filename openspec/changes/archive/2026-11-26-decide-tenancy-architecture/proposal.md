# Proposal: MVP1.5 架构决策 `decide-tenancy-architecture`

- Change: `decide-tenancy-architecture`
- 阶段：MVP1.5，MVP1 收尾后、MVP2 开始前
- 时间：2–3 天
- 类型：**只写文档，不改代码**
- 依据：`~/workspace/personal-agent-mvp1-upgrade-roadmap.md` 第 MVP1.5 节（2026-11-26 新版）
- 基线：代码基线 `5987204e3`，工作基线 `92eb6457ff128d4bbbd622ab9e4b42da4200f473`
- 本地路径：`/Users/latiao/OpenMausBot`
- 远程仓库：https://github.com/latiao-ai/personal-agent

## 现状

MVP0 已跑通，MVP1 已到 R2 收尾：飞书私聊收发、白名单拒绝、进程重启不重复回复、单 WebSocket 自动重连都已验证。剩下：另一个白名单外账号的现场拒绝验收、服务器网络中断恢复验收、维护者最终审计。`bootstrap-dev-workspace` 也还在等审计。

但有几个会决定后面所有存储位置的问题，还没有落成文档：

1. 一台 VM 对应一个企业客户，还是一个用户？Ticket、审批、Vault、记忆存在 VM 里，还是控制面？
2. 一台服务器上跑多台 VM，资源、网络、迁移怎么定？
3. VM 里用什么模型接入？总 API Key 放哪？
4. `enterprise/` 目录留不留？对外售卖要不要商业授权？
5. OpenMausBot 上游更新很快，怎么同步才不把改动冲掉？

如果这些问题不在 MVP2 之前定下来，MVP2（Ticket + 审批）、MVP4（巡检）、MVP5（记忆与技能）做完后，到了 MVP6 才发现 Ticket 存在错地方、记忆存在错地方、网关放错地方，就要全部返工。

## 目标

做完这个 change 之后：

- `design.md` 里有一张**控制面 / VM 边界图**，一眼能看出什么在 VM 外、什么在 VM 内。
- 下面 6 个决策，每一项都有**结论**，不是“待定”：
  1. 租户粒度
  2. 宿主机规范（配额、网络、迁移）
  3. 控制面与 VM 的边界
  4. 引擎接入（第三方中转站 API Key）
  5. `enterprise/` 目录的去留与许可证
  6. 上游同步策略
- MVP2–MVP6 按这份文档写代码，不再为“存在哪”返工。

## 已确认的结论（2026-11-26）

| 决策 | 结论 |
|---|---|
| 租户粒度 | 一台云服务器上运行多个用户，**每个用户一台 microVM，同一用户的多个 Bot 共享这台 VM**。用户的个人数据、浏览器登录、记忆、技能都在 VM 里。用户之间靠 VM 硬隔离；同一 VM 内的 Bot 之间只做权限区分（各自的工具白名单和工作目录），不做硬隔离。以后支持“企业客户下有多个用户”时，企业这一层只在控制面里做（成员、策略、共享技能模板、汇总计费），不改变“一用户一 VM”的模型 |
| 控制面 / VM 边界 | **VM 外（控制面）**：IM 网关、租户与身份、Ticket 与 Mandate 存储、审批记录、预算计数、Vault、LLM 转发代理、审计日志。**VM 内**：OpenMausBot 运行时（`openmausbot serve`）、会话、记忆、技能、浏览器和工作文件。原则：**凡是用来约束 agent 的东西，都不能放在 agent 能写的地方** |
| 引擎 | 接入**第三方中转站的 API Key**（OpenAI / Anthropic 兼容端点，见 `docs/custom-engines.md`），不用本机订阅登录的 `claude` / `codex` CLI。中转站总 Key 放在控制面 LLM 代理层，不直接放进用户 VM |
| `enterprise/` | **先保留继续用**。开发、测试与评估免费（无 `OMB_LICENSE_KEY` 时默认跑 OSS 版）；但生产启用、对外托管（host for third parties / SaaS）或白标必须向版权方（Milind Soni）取得商业/合作授权，且不得绕过 license 校验或未经授权分发。上线对外售卖前二选一：买正式托管授权，或把用到的一小块能力迁到自研控制面后删除该目录 |
| 宿主机 | 每台用户 VM 建议默认配额为 2 vCPU / 4 GB 内存 / 20 GB 持久磁盘；网络默认隔离，单机密度与唤醒延迟在 MVP6 实测后定终值；磁盘迁移或快照恢复 |
| 上游同步 | 建立 `upstream` 远程，每两周通过独立 change 同步并在隔离环境做全量验证；核心改动集中清单审查，优先在独立目录或服务接入 |

## 不做

- **不改任何业务代码**：不写网关、不写 Ticket、不写审批、不改 harness。
- **不做 MVP6 的实现**：不真的去建 microVM 池、不做宿主机调度、不做 VM 休眠唤醒。那是 MVP6（4–8 周）的事。
- **不做平台选择**：淘宝 / Shopify / 亚马逊 / 京东，先做哪个平台，不在这个 change 里定。
- **不做技能分档审批**：技能只分两类，核心技能（采购、付款、删数据）锁死，其他技能 agent 自己改、不用批。分档太麻烦，已明确不要。
- **不 fork Hermes 等外部 agent**：Hermes 后续可评估作为 ACP 引擎接入，但不 fork。

## 成功标准

- [x] `design.md` 里有控制面 / VM 边界图，图中每一项都能对应到本文的结论表
- [x] 6 个决策每项都有结论，宿主机配额、网络、迁移三项有具体数值或明确的“待确认 + 默认值”
- [x] 边界图与 MVP2a 的 Ticket 存储、MVP2b 的 Vault / 审批、MVP5 的记忆与技能、MVP6 的隔离，没有矛盾
- [x] 维护者已确认（R1），`handoff.md` 里有确认记录
- [x] `openspec validate --all --strict --no-interactive` 通过
- [x] 已执行 `openspec archive decide-tenancy-architecture`

## 风险

- 结论写得太笼统，MVP2 写代码时还是不知道 Ticket 存在哪。防法：design 里每个存储项都写明“存在哪、谁能写、谁能读、丢了怎么办”。
- 宿主机数值拍脑袋，MVP6 才发现单机塞不下几台 VM。防法：本 change 只定“怎么算、怎么量”，数值先给建议默认值，MVP6 验证后再定终值，见 design.md 第 3 节。
- `enterprise/` 的许可证被忽略，上线才发现要授权。防法：本 change 明确写出授权要求和二选一方案，MVP6 之前必须二选一，不能拖。
