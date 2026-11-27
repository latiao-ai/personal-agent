## ADDED Requirements

### Requirement: 统一账号密码登录入口与服务端路由守卫
系统 MUST 提供唯一登录入口 `/login`（仅账号 + 密码，无手机号登录、无自助注册、无飞书扫码登录入口），登录后按角色自动跳转（客户账号跳 `/portal`，管理员账号跳 `/admin`），并由服务端路由守卫强制拦截未登录与跨角色页面及接口访问。

#### Scenario: 客户与管理员按角色跳转
- **WHEN** 客户或管理员在 `/login` 使用正确账号密码登录
- **THEN** 客户跳转 `/portal` 且仅可见本租户数据，管理员跳转 `/admin` 且可见所有租户

#### Scenario: 未登录或跨角色直开受保护路由被服务端拦截
- **WHEN** 未登录用户直接访问 `/portal`、`/admin` 或直接调用后端接口，或已登录客户访问 `/admin`、管理员访问 `/portal`
- **THEN** 服务端返回 302 跳转至 `/login` 或各自页面（API 返回 401/403），不暴露受保护内容

### Requirement: 后台建号、密码哈希存储与测试账号自动跳转
系统 MUST 禁止自助注册（直接调用注册接口返回 403），仅允许管理员在 `/admin` 创建账号、修改密码与停用账号；密码 MUST 使用 scrypt 加盐哈希存储且不出现在代码、URL 或日志中；创建客户测试账号（如 `tanghaonan`）后 MUST 自动签发会话并跳转至 `/portal`。

#### Scenario: 自助注册被拒绝且新建测试账号自动跳转
- **WHEN** 外部调用自助注册接口，或管理员在 `/admin` 创建客户测试账号 `tanghaonan`
- **THEN** 自助注册返回 403；后台创建账号后以 HttpOnly Cookie 自动跳转 `/portal` 且 URL、日志和数据库中无明文密码

#### Scenario: 停用账号立即吊销全部会话
- **WHEN** 管理员停用某个账号
- **THEN** 该账号已有会话立即失效（返回 401），再次登录被拒绝

### Requirement: 身份映射与任意 Bot 接飞书及个人微信
系统 MUST 在控制面数据库维护 `ChannelBinding`（按 `(platform, chat_id)` 唯一活跃绑定与去重凭据检查）、独立的 `UserIdentity`（飞书 `open_id`）与 `WeixinIdentity`（个人微信 iLink），以及按租户隔离的白名单表；平台密钥仅存控制面 Vault；企业微信 `WeComAdapter` 仅保留占位接口。

#### Scenario: 任意非管理 Bot 绑定飞书群与解绑隔离
- **WHEN** 客户在门户「消息平台」页将任意 Bot 绑定至内部飞书群，或尝试给同一群绑定第二个 Bot，或解绑后再次 `@`
- **THEN** 绑定后群内 `@` 路由到对应 Bot；重复绑定同群被拒绝（409）；解绑后不再回复并记录拒绝日志

#### Scenario: 个人微信 iLink 私聊与租户白名单隔离
- **WHEN** 客户通过个人微信 iLink 扫码绑定并私聊发消息，或租户 A 修改本租户白名单
- **THEN** 个人微信私聊由绑定 Bot 回复且页面注明“个人微信以私聊为主”；租户 A 白名单修改不影响租户 B

### Requirement: 常驻多平台网关与单消费者去重
系统 MUST 以单个控制面常驻网关进程承载 `FeishuAdapter` 与 `WeixinAdapter`（支持 `launchd` / `systemd` 拉起与绑定热加载），启动时声明唯一消费者锁并检测冲突进程，且按 `event_id` 持久化去重。

#### Scenario: 冲突消费者检测与事件去重
- **WHEN** 存在同应用冲突消费者（如手动脚本或 `lark-cli`），或飞书重投相同 `event_id`
- **THEN** 冲突消费者启动被明确拒绝；重投事件被去重忽略，不产生重复回复

### Requirement: 控制面 LLM 代理统一中转 DeepSeek
系统 MUST 提供控制面 OpenAI 兼容 LLM 代理转发至第三方 DeepSeek 中转站，总 Key 仅存控制面 Vault / 环境变量且不进入 VM 或日志，VM 仅持有带租户与预算边界的短期虚拟令牌；中转站异常时触发熔断/切换而非无限重试；Jev 快分流接入中转小模型并保留 500 ms 超时回落规则；不再依赖本机 CLI 登录。

#### Scenario: 虚拟令牌校验、熔断切换与无本地 CLI 运行
- **WHEN** Bot 持有效/过期/吊销/超预算虚拟令牌请求模型，或主中转站故障，或本机无 `codex`/`claude` CLI
- **THEN** 过期、吊销与超预算令牌立即被拒；主中转站故障触发熔断并切换备用或降级；就绪检查报 `localCliRequired: false` 且 Jev 保留 500 ms 超时回落 lead bot
