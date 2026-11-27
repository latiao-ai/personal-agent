# Tasks: 统一登录 + 任意 Bot 接消息平台 + 中转 DeepSeek `add-unified-login`

- 时间：3–4 周（估计值，本地 agent 按第 0 步盘点后确认）
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手，不要从零写）

- [x] 0. 对照本地目录，列出已有模块：`src/main.tsx` 的路由分发、`server/portal/engine.ts` 的扫码登录、`server/routes/portal.ts`（原注 `server/portal/routes/portal.ts` 已核正）、`server/index.ts` 的 `createPortalHost`、`portal.sqlite` 的表结构、`scripts/feishu_gateway.py` 的启动参数和路由 JSON、现有模型调用层（内置 `openai-compat` 驱动、`server/routing/jev.ts`、`server/approvals/vault.ts`）、控制面 LLM 代理（无现成代理，需新建）。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 `add-customer-portal` 已完成并推送（最新提交 `d04dfe78e`）：`/portal` 和 `/admin` 两个路由、双通道审批、SSE 推送，本 change 不重做这些，只加登录入口和守卫。
- [x] 0. 按 design.md §4.1 核对 Hermes 最新文档：适配器名、权限名（`im.message.receive_v1`、`im:message:send_as_bot`、`im:message:send`、`card.action.trigger` 等）和配置项，错的改过来，不要照抄旧的。
- [x] 0. 核对中转站文档：中转站的 `base_url`、支持的 DeepSeek 模型名、Key 格式、限流和计费口径；确认控制面 LLM 代理需新建，通过控制面 Vault/环境变量配置，不硬编码 Key。
- [x] 0. 核对个人微信 iLink：Hermes 的 Weixin 适配器通过腾讯 iLink Bot API 长轮询 + 扫码登录生成 `xxx@im.bot` 机器人身份；iLink 账号 ID / token 存控制面 Vault；群聊限制仍为“私聊为主，一般不能进普通微信群”。
- [x] 0. 确认 MVP6 `add-isolation-deploy` 的状态：已完成、归档（`openspec/specs/isolation-deploy/spec.md`）并推送 `55214e76a`，网关常驻服务与部署规则对齐。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：`openspec new change add-unified-login`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [x] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好（定稿），核对一遍本地目录名、路由和函数名，错的改过来。
- [x] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：统一登录入口 + 服务端路由守卫

- [x] 4. 新建 `/login`：账号 + 密码登录，客户账号和管理员账号都在这里登，不再分两个登录框。
- [x] 5. 登录后按角色跳转：客户 → `/portal`，管理员 → `/admin`。
- [x] 6. 服务端路由守卫：没登录直接打开 `/portal` 或 `/admin` → 跳回 `/login`；角色不对 → 跳回自己的页面 / 403。守卫在服务端做，不只靠前端藏入口。
- [x] 7. 收掉现在各管各的登录框：登录只在 `/login` 做一次，进了自己的页面就不用再登一次。`/portal` 和 `/admin` 的业务代码一行业务都不删；飞书扫码登录的二维码接口不要删，先留着，但不再当登录入口。

## 第 3 步：账号注册方式 + 测试账号自动跳转

- [x] 8. 注册不开放自助：没有自助注册入口，直接调注册接口也被拒绝。
- [x] 9. 在 `/admin` 里建账号：管理员能在后台管理页面里建账号、改密码、停用账号。`OMB_ADMIN_USERNAME` / `OMB_ADMIN_PASSWORD` 只留作第一次冷启动建第一个管理员的办法。
- [x] 10. 老账号单独设账号密码：主界面那个老账号（唐浩南）设一个账号密码登录，专门留着测试用，不绑手机号。
- [x] 11. 密码存哈希，不存明文；密码不写进代码、不提交到 GitHub、不出现在日志里。沿用 `server/portal/admin.ts` 的 scrypt 哈希 + 盐。
- [x] 12. 建完自动跳到测试账号：管理员建完账号（测试账号用户名 `tanghaonan`），管理后台自动跳转到这个新建的测试账号上，能马上验证；跳转时不要把明文密码带在 URL 里。

## 第 4 步：身份映射 + 绑定表

- [x] 13. 账号 → `user_id` → `tenant_id` → Bot 列表：登录后 session 里带 `user_id` 和 `tenant_id`，后端按 `tenant_id` 过滤，只返回这个租户的东西。
- [x] 14. 新建 `ChannelBinding` 表：`bot_id`、`tenant_id`、`platform`（feishu / weixin）、`platform_app_id` / `bot_id`、`feishu_chat_id` / `weixin_chat_id`、`chat_type`（p2p / group）、`status`（active / disabled）。
- [x] 15. 新建 `UserIdentity` 表：`user_id`、`tenant_id`、`feishu_open_id`；新建 `WeixinIdentity` 表：`user_id`、`tenant_id`、`weixin_open_id` / iLink 账号 ID；portal 里做绑定流程（群里 @ 发绑定码，或 portal 里点“绑定飞书账号”）。
- [x] 16. 平台凭据进控制面 Vault，按租户分开：飞书 App ID / Secret、个人微信 iLink token 不进代码、不进仓库、不进日志。

## 第 5 步：任意 Bot 接消息平台（Hermes 式网关，本次就做常驻）

- [x] 17. 网关按绑定表路由：收到消息拿 `chat_id` → 查绑定表找到 `bot_id` → 查 `tenant_id` → 确认群属于这个租户 → 才转给这个 Bot。不再写死 `--bot` / `--thread`。
- [x] 18. 一个网关进程 + 平台适配器：新建 `FeishuAdapter` / `WeixinAdapter`，统一收消息格式；`WeComAdapter` 只留空接口 / 占位，本次不接通。
- [x] 19. 网关常驻服务：Mac 上 launchd 用户服务，Linux 上 systemd 服务，`Restart=always`，跟着项目一起启动；上线前先停掉手动跑的 `feishu_gateway.py` 和 `lark-cli`，启动时声明唯一消费者。
- [x] 20. portal 里给每个 Bot 加一个「消息平台」页：选飞书填 App ID / Secret，选个人微信走 iLink 扫码，保存后网关热加载，不用重启整个项目。
- [x] 21. 一个群同一时间只允许一个 active 绑定：换绑要先解绑旧的；同一个 `(平台, token)` 在两个 Bot 里会被停掉一个。
- [x] 22. 白名单按租户配，落在数据库里：一个客户改白名单不影响另一个客户。
- [x] 23. 先拿内部群验证收消息、@、回复都通了，再按 design.md §4.6 做外部群的对外共享认证和发布；群消息接收权限开了并发布新版本才算完。个人微信先验证私聊，群聊不承诺。

## 第 6 步：所有 Bot 统一走中转 DeepSeek

- [x] 24. 控制面 LLM 代理：配好 OpenAI 兼容 provider，中转站总 Key 只放控制面 Vault / LLM 代理层，不进 VM、不进代码、不进日志、不进镜像。
- [x] 25. 模型调用改路：Bot → harness → 控制面 LLM 代理 → 中转站 → DeepSeek；VM 只拿带租户标识的临时令牌；Jev 快分流也走中转站小模型，500 ms 超时回落规则不变。
- [x] 26. 去掉本地 CLI 前置：启动检查里“至少一个 agent CLI 已登录”改为“控制面 LLM 代理可达、中转站 Key 有效”；停掉本地 `codex` 后 Bot 还能回。
- [x] 27. 中转站熔断 / 切换：中转站不可用时按预算规则降级，不要无限重试；令牌过期、吊销、超预算立即失效。

## 第 7 步：测 + 归档

- [x] 28. 按 specs/unified-login.md 一条一条测，不要只测 happy path，也要测坏情况（见 specs），尤其要测没登录直开路由、角色不对串页面、一个群两个 Bot 抢回、不属于这个租户的群发消息、杀掉网关进程、停掉本地 CLI 这六种。
- [x] 29. 审计 + 归档：`openspec validate --all --strict --no-interactive` 通过，`openspec archive add-unified-login`，再推到 GitHub。
