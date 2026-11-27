## ADDED Requirements

### Requirement: 管理员在后台配置模型 Provider
系统 SHALL 在 `/admin` 提供模型配置入口，管理员可配置中转站地址、API Key、默认模型、分流小模型、启用状态。

#### Scenario: 管理员首次配置
- **WHEN** 管理员登录 `/admin`，打开“模型配置”，填写 `baseUrl=https://api.xxx.com/v1`、`apiKey`、`defaultModel=deepseek-chat`，点击保存
- **THEN** 接口返回 200，页面显示“已配置”，不显示 Key 明文，只显示后 4 位

#### Scenario: 管理员只改模型不改 Key
- **WHEN** 管理员修改 `defaultModel`，`apiKey` 留空，点击保存
- **THEN** 旧 Key 仍可用，下一次模型调用使用新的 `defaultModel`

#### Scenario: 管理员填错地址
- **WHEN** 管理员填写的 `baseUrl` 不是 `https://` 开头
- **THEN** 接口返回 400，配置不保存，当前生效配置不变

### Requirement: Key 只存 Vault，永不外泄
系统 SHALL 把 API Key 只存进控制面 Vault，任何接口、日志、审计、前端都不返回 Key 明文。

#### Scenario: 管理员查询 Provider 列表
- **WHEN** 管理员调 `GET /api/admin/llm/providers`
- **THEN** 返回的每个 Provider 只有 `apiKeyConfigured: true` 和 `apiKeyLast4: "****1234"`，无明文 Key 字段

#### Scenario: 客户查询用量
- **WHEN** 客户调 `GET /api/portal/llm/usage`
- **THEN** 返回只有模型名、token 数、费用、剩余额度，无 `baseUrl`、无 Key、无成本价

### Requirement: 轮换 Key
系统 SHALL 支持管理员轮换 API Key，轮换后旧 Key 立刻失效。

#### Scenario: 轮换 Key
- **WHEN** 管理员在“模型配置”点“轮换 Key”，输入新 Key 并二次确认
- **THEN** 旧 Key 调代理返回 401，新 Key 可以正常调用，审计里记一条 `llm_api_key_rotated`

#### Scenario: 轮换未二次确认
- **WHEN** 管理员调轮换接口但 `confirm` 不是 `true`
- **THEN** 接口返回 400，Key 不变

### Requirement: 定价与记账
系统 SHALL 按管理员配置的定价表记账，每次模型调用都同时记录成本和收入。

#### Scenario: 一次调用记账正确
- **WHEN** 租户调用一次模型，中转站返回 `prompt_tokens=1000`、`completion_tokens=500`，定价表为输入 1 元/1M、输出 2 元/1M（成本），输入 2 元/1M、输出 4 元/1M（售价）
- **THEN** `llm_usage_daily` 当日行增加 `cost=0.002`、`revenue=0.004`（允许浮点误差 1e-6）

#### Scenario: 售价低于成本
- **WHEN** 管理员设置 `price < cost`
- **THEN** 接口返回 400，定价不保存

### Requirement: 租户额度与熔断
系统 SHALL 在调用前校验租户当日额度，超额度直接拒绝，不调中转站、不扣费。

#### Scenario: 超 token 额度
- **WHEN** 租户当日已用 token 达到 `maxTokensPerDay`，再发起一次调用
- **THEN** 代理返回 402，中转站没有收到这次请求

#### Scenario: 管理员调大额度后恢复
- **WHEN** 管理员把该租户的 `maxTokensPerDay` 调大
- **THEN** 该租户下一次调用可以正常进行

### Requirement: 测试连通性不影响生效配置
系统 SHALL 提供测试连通性接口，测试失败不改变当前生效配置。

#### Scenario: 测试失败
- **WHEN** 管理员对一个填错地址的 Provider 点“测试连通性”
- **THEN** 接口返回 `ok: false` 和错误原因，当前生效 Provider 仍可正常调用

### Requirement: 权限隔离
系统 SHALL 在服务端校验管理员身份，客户账号调用管理员接口返回 403。

#### Scenario: 客户调管理员接口
- **WHEN** 客户账号调 `GET /api/admin/llm/providers`
- **THEN** 返回 403

#### Scenario: 未登录调管理员接口
- **WHEN** 未登录调 `GET /api/admin/llm/providers`
- **THEN** 返回 401

### Requirement: 启动迁移兼容环境变量
系统 SHALL 在首次启动时把环境变量配置迁移进数据库，之后数据库配置优先。

#### Scenario: 老部署首次启动
- **WHEN** `llm_providers` 表为空，且环境变量 `OMB_LLM_RELAY_BASE_URL` + `OMB_LLM_RELAY_API_KEY` 都有值，服务启动
- **THEN** 库里出现 `id=primary-deepseek-relay` 的 Provider，`GET /api/admin/llm/providers` 能看到它，模型调用仍可用

#### Scenario: 管理员改过之后
- **WHEN** 管理员在后台改过 Provider 配置，服务重启
- **THEN** 生效的是数据库里的配置，不是环境变量里的旧值
