# Design: add-admin-llm-config

## 1. 架构：配置进库，Key 进 Vault，调用走代理

```
┌─────────────┐      ┌──────────────────────┐
│ /admin      │ POST │ /api/admin/llm/*     │
│ 模型配置页   │─────▶│ PortalAdminOps       │
└─────────────┘      │  - 校验管理员身份     │
                     │  - 写 llm_providers  │
                     │  - 写 llm_pricing    │
                     └──────┬───────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
     portal.sqlite   ControlPlaneVault  ControlPlaneLlmProxy
     llm_providers   llm_relay:<id>     registerProvider /
     llm_pricing     :api_key           chatCompletions /
     llm_usage_daily                    createJevSmallModel
              ▲             ▲             ▲
              │             │             │
              └─────────────┴─────────────┘
                     启动时 loadProvidersFromStore
```

原则（沿用 MVP1.5 / MVP2b 的控制面原则）：

1. **凡是用来约束 agent 的东西，都不能放在 agent 能写的地方。** Provider 配置、定价、额度都在控制面，VM 只能拿临时虚拟令牌调用。
2. **Key 永远不出控制面。** 管理员填 Key 只写 Vault，读只返回 `apiKeyConfigured + apiKeyLast4`，日志、审计、接口、前端一律不记录明文。
3. **配置和密钥分离。** `llm_providers` 表只存地址、模型名、开关、优先级；Key 只存 Vault，表里不存 Key 的任何形式。

## 2. 复用盘点（Step 0 必须先核对本地实际文件）

| 现有模块 | 位置 | 复用方式 | 是否改动 |
|---|---|---|---|
| LLM 代理 | `server/llm-proxy/engine.ts` | 复用 `ControlPlaneLlmProxy`、`registerProvider`、`chatCompletions`、`createJevSmallModel`、`issueVirtualToken` | 改：加 `loadProvidersFromStore`、`updateProvider`、`testProvider`；改记账为按定价表 |
| 共享类型 | `shared/llm-proxy.ts` | 复用 `LlmRelayProviderConfig`、`LlmVirtualTokenRecord` | 改：加 `AdminLlmProviderView`、`LlmPricing`、`TenantLlmUsage` |
| Vault | `server/approvals/vault.ts` | 复用 `ControlPlaneVault.setSecret`，secret 名格式已存在：`llm_relay:<id>:api_key`，租户分区 `_control_plane_llm` | 不改 |
| 管理员操作 | `server/portal/admin.ts` | 复用 `PortalAdminOps`、`recordAudit`、`throwError` | 改：加 LLM 相关方法，`AdminOpsDeps` 加 `llmProxy` |
| Portal 存储 | `server/portal/store.ts` | 复用 `portal.sqlite` | 改：加 3 张表 |
| 路由 | `server/routes/portal.ts` | 复用 `/api/admin/*` 的管理员守卫 | 改：加 `/api/admin/llm/*` + `/api/portal/llm/usage` |
| 启动装配 | `server/index.ts` | 复用 `createPortalHost` 装配 | 改：启动时迁移环境变量、加载 Provider、注入 `llmProxy` |
| 管理后台前端 | `src/admin/AdminConsoleApp.tsx` | 复用 `adminApi`、`refreshAll`、`session` 守卫 | 改：加模型配置区块 |
| 客户门户前端 | `src/portal/CustomerPortalApp.tsx` | 复用现有用量/消耗展示结构 | 改：加只读 LLM 用量区块 |

本地核对清单（实现前在 Mac 上逐项确认，名字以本地为准，云端看到的名字可能滞后）：
- `server/llm-proxy/engine.ts` 里 `registerProvider` 的 Vault secret 名、`defaultModel` / `fastModel` 默认值（云端看到的是 `deepseek-chat`）。
- `server/portal/store.ts` 里 `portal.sqlite` 的建表位置和迁移方式。
- `server/routes/portal.ts` 里 `/api/admin/*` 的守卫函数名（未登录 401 / 非管理员 403）。
- `src/admin/AdminConsoleApp.tsx` 里 `refreshAll` 的并发拉取写法。
- `server/index.ts` 里 `createPortalHost` 的参数和 `llmProxy` 的创建位置。

## 3. 数据模型

### 3.1 `portal.sqlite` 新增 3 张表

```sql
CREATE TABLE IF NOT EXISTS llm_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  default_model TEXT NOT NULL,
  fast_model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_pricing (
  provider_id TEXT PRIMARY KEY,
  cost_input_per_1m REAL NOT NULL,
  cost_output_per_1m REAL NOT NULL,
  price_input_per_1m REAL NOT NULL,
  price_output_per_1m REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY'
);

CREATE TABLE IF NOT EXISTS llm_usage_daily (
  tenant_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  date TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, provider_id, date)
);
```

租户额度复用现有虚拟令牌的默认值，不新增表：`maxTokensPerDay` 默认 200,000，`maxCostUsdPerDay` 默认 50，管理员按租户单独调时写进虚拟令牌签发参数和 `llm_usage_daily` 的校验逻辑里。

### 3.2 共享类型（`shared/llm-proxy.ts`）

```ts
export interface AdminLlmProviderView {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  fastModel: string;
  enabled: boolean;
  priority: number;
  apiKeyConfigured: boolean;
  apiKeyLast4: string;
  updatedAt: number;
  updatedBy: string;
}

export interface LlmPricing {
  providerId: string;
  costPer1MInputTokens: number;
  costPer1MOutputTokens: number;
  pricePer1MInputTokens: number;
  pricePer1MOutputTokens: number;
  currency: "CNY";
}

export interface TenantLlmUsage {
  tenantId: string;
  date: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  revenue: number;
  maxTokensPerDay: number;
  maxCostPerDay: number;
}
```

## 4. 后端：代理改造

### 4.1 `server/llm-proxy/engine.ts`

保留构造函数里读环境变量的代码，只当首次启动引导。新增：

```ts
loadProvidersFromStore(store): void
updateProvider(input: {
  id: string; name: string; baseUrl: string;
  apiKey?: string; // 空 = 不改 Key
  defaultModel: string; fastModel?: string;
  enabled: boolean; priority: number;
}): void
testProvider(id: string): Promise<{ ok: boolean; latencyMs: number; error?: string }>
```

- `loadProvidersFromStore`：读 `llm_providers` 中 `enabled=1` 的行，按 `priority` 排序，逐个 `registerProvider`，Key 从 Vault 取。Vault 里没有 Key 的行跳过并记日志，不阻塞启动。
- `updateProvider`：有新 Key 时先写 Vault（`llm_relay:<id>:api_key`），再更新内存中的 Provider；无新 Key 时只改配置，不动 Vault。
- `testProvider`：用 `fastModel` 发一次最小调用（`max_tokens: 5`，`temperature: 0`），只测通不通，不记账、不写用量表。超时 5 秒，失败返回错误，不改变当前生效配置。

### 4.2 记账与熔断（改 `chatCompletions`）

当前实现是固定 `totalTokens * 0.5 / 1M` 算成本，改为按定价表：

1. 调用前：查 `llm_usage_daily`（今天、该租户、该 Provider），若 `input+output` 已超 `maxTokensPerDay` 或 `cost` 已超 `maxCostPerDay`，直接抛 402，不调中转站。
2. 调用后：按 `usage.prompt_tokens / completion_tokens` 分别乘 `cost_*_per_1m` 和 `price_*_per_1m`，算出 `cost` 和 `revenue`，累加进 `llm_usage_daily`，同时更新虚拟令牌的 `usedTokensToday / usedCostUsdToday`。
3. 中转站返回的 `usage` 为空时，按 100 token 兜底（沿用现有兜底逻辑），不静默记 0。

### 4.3 新 store 文件

新建 `server/llm-proxy/store.ts`，封装 3 张表的读写：

- `listProviders()`、`getProvider(id)`、`upsertProvider(row)`、`getPricing(providerId)`、`upsertPricing(row)`、`addUsage(tenantId, providerId, date, input, output, cost, revenue)`、`getUsage(tenantId, date)`。
- 所有写操作用事务，`addUsage` 用 `INSERT ... ON CONFLICT DO UPDATE` 累加，避免并发丢数。

## 5. 后端：管理员操作与路由

### 5.1 `server/portal/admin.ts`

`AdminOpsDeps` 增加 `llmProxy: ControlPlaneLlmProxy` 和 `llmStore`。新增方法：

| 方法 | 说明 |
|---|---|
| `listLlmProviders(actor)` | 返回脱敏视图，永远不返回 Key |
| `saveLlmProvider(actor, input)` | 新建/更新，`apiKey` 为空 = 不改 Key；`baseUrl` 必须 `https://` 开头；`defaultModel` 必填 |
| `rotateLlmApiKey(actor, providerId, newApiKey)` | 换 Key，旧 Key 立刻失效，需二次确认（`confirm: true`） |
| `testLlmProvider(actor, providerId)` | 调 `llmProxy.testProvider` |
| `setLlmPricing(actor, providerId, pricing)` | 校验 `price >= cost`，否则 400 |
| `setTenantLlmBudget(actor, tenantId, input)` | 改租户每日 token/费用上限 |
| `getTenantLlmUsage(actor, tenantId, date)` | 管理员看任意租户用量 |

每个方法末尾调 `recordAudit`，`tenantId: "_control_plane"`，`action` 为 `llm_provider_saved` / `llm_api_key_rotated` / `llm_pricing_set` / `llm_budget_set`，`after` 只写模型名、价格、额度，**不写 Key**。

### 5.2 `server/routes/portal.ts`

新增路由，守卫复用现有 `/api/admin/*`：未登录 401，非管理员 403。

```
GET    /api/admin/llm/providers
POST   /api/admin/llm/providers
PUT    /api/admin/llm/providers/:id
POST   /api/admin/llm/providers/:id/test
POST   /api/admin/llm/providers/:id/rotate
GET    /api/admin/llm/pricing/:providerId
PUT    /api/admin/llm/pricing/:providerId
GET    /api/admin/llm/usage/:tenantId?date=YYYY-MM-DD
PUT    /api/admin/llm/tenants/:tenantId/budget
GET    /api/portal/llm/usage
```

- `POST /api/admin/llm/providers`：`id` 不传 = 新建（服务端生成 `prov_<uuid>`），传了 = 更新。
- `PUT /api/admin/llm/providers/:id`：与 POST 同逻辑，保留两条是为了兼容前端习惯，二选一实现即可，但文档里只写一套。
- `GET /api/portal/llm/usage`：只返回当前登录租户的用量，字段为模型名、今日/当月 token、费用、剩余额度；**不返回 `baseUrl`、Key、成本价**。

### 5.3 启动迁移（`server/index.ts`）

启动顺序：

1. 创建 `ControlPlaneLlmProxy`。
2. 若 `llm_providers` 表为空，且环境变量 `OMB_LLM_RELAY_BASE_URL` + `OMB_LLM_RELAY_API_KEY` 都有值，把环境变量那一套写进库 + Vault，`id` 固定为 `primary-deepseek-relay`，`name` 为 `DeepSeek Relay`，`defaultModel` / `fastModel` 取环境变量或默认 `deepseek-chat`。
3. 调用 `loadProvidersFromStore`，注册所有启用的 Provider。
4. 把 `llmProxy` 传给 `PortalAdminOps`。

管理员在后台改过一次之后，数据库配置优先于环境变量，环境变量不再生效（除非表被清空）。

## 6. 前端

### 6.1 管理后台（`src/admin/AdminConsoleApp.tsx` + 新建 `src/admin/AdminLlmSection.tsx`）

在“所有租户与云桌面状态”区块下方新增“模型配置”区块，`refreshAll` 里多拉一个 `GET /api/admin/llm/providers`。

表单字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| 供应商名称 | 文本 | 如 `DeepSeek 中转站` |
| 中转站地址 | 文本 | 必须 `https://` 开头 |
| API Key | 密码框 | `placeholder="已配置 ****1234，留空不改"` |
| 默认模型 | 文本 | 如 `deepseek-chat` |
| 分流小模型 | 文本 | 不填默认跟主模型一样；Jev 分流用这个 |
| 成本价（输入/输出） | 数字 | 元 / 1M token |
| 售价（输入/输出） | 数字 | 元 / 1M token，必须 ≥ 成本价 |
| 是否启用 | 开关 | 停用后不再接新调用，已在途调用不受影响 |
| 按钮 | — | `保存`、`测试连通性`、`轮换 Key`（轮换需二次确认） |

保存后显示：`已配置`、`后 4 位`、`上次更新人 / 时间`，永远不回显完整 Key。测试失败时显示错误，不改变当前生效配置。

### 6.2 客户门户（`src/portal/CustomerPortalApp.tsx`）

新增只读区块“模型用量”，字段：当前可用模型名、今日 token、今日费用、当月 token、当月费用、剩余额度。数据来自 `GET /api/portal/llm/usage`。不展示 Key、地址、成本价，不提供任何配置入口。

## 7. 安全与审计

- Key 写入：只走 `POST/PUT /api/admin/llm/providers` 和 `POST /api/admin/llm/providers/:id/rotate`，管理员身份校验在服务端，不依赖前端隐藏。
- Key 读取：任何接口、日志、审计、前端都不返回明文；`apiKeyLast4` 只用于管理员确认是哪个 Key。
- Key 轮换：旧 Key 立刻失效，正在使用的虚拟令牌不受影响（虚拟令牌不含主 Key），下一次代理调用即用新 Key。
- 审计：每次保存、轮换、改价、改额度都写 `PortalAuditEntry`，`tenantId: "_control_plane"`，可被管理员在审计列表里查到。
- 租户隔离：用量按 `tenantId` 分表记录，客户只能查自己的；管理员查任意租户需管理员会话。

## 8. 不做的事情

- 不做多 Provider 自动 failover 之外的负载均衡，`priority` 只决定注册顺序和 `createJevSmallModel` 选第一个启用的 Provider。
- 不做在线支付、充值、发票。
- 不做租户自带 Key。
- 不改 Jev 的 500ms 超时和 0.6 阈值（`server/routing/jev.ts` 不动）。
- 不改虚拟令牌的签发逻辑（`issueVirtualToken` 不动），只在调用时多一层用量校验。
