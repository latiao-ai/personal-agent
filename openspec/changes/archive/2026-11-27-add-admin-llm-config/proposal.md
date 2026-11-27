# Change: add-admin-llm-config

## Why

`add-unified-login`（main `bf1dc3a`）已经做了控制面 LLM 代理：

```
Bot / VM → 临时虚拟令牌 → 控制面 LLM 代理 → 中转站 → DeepSeek
```

主 Key 只在控制面 Vault 里，VM 永远拿不到真 Key。但配置来源还是环境变量：

```bash
OMB_LLM_RELAY_BASE_URL
OMB_LLM_RELAY_API_KEY
OMB_LLM_RELAY_MODEL
OMB_LLM_RELAY_FAST_MODEL
```

这不是 SaaS 的做法。管理员改一次 Key 要改服务器配置、重启服务；客户看不到用量；没有定价和额度，无法按量收费，一个租户也可能把 Key 刷爆。

本次 change 的目标：**把模型配置从环境变量搬到管理员后台**，管理员在 `/admin` 里统一配 Key、定模型、定价、定额度，租户只能用、只能看自己的用量。

## What changes

- 管理员后台新增“模型配置”页：配中转站地址、API Key、默认模型、分流小模型、启用/停用、成本价、售价。
- Key 存进控制面 Vault，接口和页面永远只返回“已配置 + 后 4 位”，不返回明文。
- 新增定价表和每日用量表，代理每次转发都按定价记账（成本 + 收入），超额度直接熔断，不再调中转站。
- 客户门户新增只读用量展示：今天/当月用了多少 token、花了多少钱、还剩多少额度，不展示 Key、地址、成本价。
- 环境变量保留为首次启动引导，管理员在后台改过一次之后，数据库配置优先于环境变量。

## Non-goals

- 不做多供应商自动切换/负载均衡（只支持一个主 Provider + 优先级字段预留）。
- 不做在线支付、充值、发票（只做用量和费用记录，计费口径为后续支付 change 提供输入）。
- 不做租户自带 Key（BYOK），本次所有租户共用管理员配置的 Provider。
- 不改现有的四层审批、Ticket、隔离、网关、统一登录流程。
- 不改 `OMB_LLM_RELAY_*` 的变量名，启动引导继续兼容。

## Baseline

- Repo: https://github.com/latiao-ai/personal-agent
- Baseline: main `bf1dc3a`（add-unified-login 已实现并推送）
- 依赖的已实现模块：
  - `server/llm-proxy/engine.ts`：`ControlPlaneLlmProxy`、`registerProvider`、`chatCompletions`、`createJevSmallModel`、`issueVirtualToken`
  - `shared/llm-proxy.ts`：`LlmRelayProviderConfig`、`LlmVirtualTokenRecord`、`LlmProxyReadiness`
  - `server/portal/admin.ts`：`PortalAdminOps`、`recordAudit`
  - `server/portal/store.ts`：`portal.sqlite`
  - `server/routes/portal.ts`：`/api/admin/*`、` /api/portal/*`
  - `src/admin/AdminConsoleApp.tsx`：`refreshAll`、`adminApi`
  - `src/portal/CustomerPortalApp.tsx`

## Impact

- 控制面：新增 3 张表、1 个新 store 文件、代理加载方式改变（环境变量 → 数据库）。
- 管理后台：新增一个区块/页面。
- 客户门户：新增只读用量区块。
- 安全面：Key 的写入、读取、轮换、审计全部走控制面，VM 和客户侧均无变化。
- 兼容性：已配置环境变量的现有部署，首次启动自动迁移进库，不用手动重配。

## Risks

- Key 误操作：管理员填错 Key 会导致所有租户无法调用模型。缓解：保存后必须能“测试连通性”，测试失败不影响当前生效配置；轮换 Key 需二次确认。
- 定价算错：成本/售价填反会导致亏损。缓解：售价必填且必须 ≥ 成本价（服务端校验），用量表同时记成本和收入，可对账。
- 额度误伤：额度设得太低会把正常租户熔断。缓解：默认额度沿用现有虚拟令牌默认值（200,000 token/天、$50/天），管理员可按租户单独调大。
