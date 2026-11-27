# Spec: add-unified-login（统一登录 + 任意 Bot 接消息平台 + 中转 DeepSeek）

> 每条都是一条可测的验收标准。写代码之前先读 specs，测的时候一条一条对。

## 1. 统一登录入口

- **WHEN** 客户打开 `/login` 并用客户账号登录 **THEN** 跳到 `/portal`，只看到该租户的数据。
- **WHEN** 管理员打开 `/login` 并用管理员账号登录 **THEN** 跳到 `/admin`，能看到所有租户。
- **WHEN** 未登录直接打开 `/portal` 或 `/admin` **THEN** 跳回 `/login`，不显示页面内容。
- **WHEN** 客户登录后打开 `/admin` **THEN** 跳回自己的 `/portal` 或报 403，且看不到任何其他租户的数据。
- **WHEN** 管理员登录后打开 `/portal` **THEN** 跳回 `/admin`。
- **WHEN** 登录后进 `/portal` / `/admin` **THEN** 不再弹出登录框，登录只在 `/login` 做一次。
- **WHEN** 直接调后端的 `/portal` / `/admin` 接口（不带 session） **THEN** 被拒绝，不是只在页面上藏起来。

## 2. 账号注册与测试账号自动跳转

- **WHEN** 在 `/login` 页面和 `/portal` 里找“注册”入口 **THEN** 找不到；直接调自助注册接口 **THEN** 被拒绝。
- **WHEN** 管理员在 `/admin` 里新建一个账号 **THEN** 能指定用户名、初始密码、角色、所属租户；建完后管理后台自动跳转到这个新建的测试账号上，能马上用新账号登录并看到它自己的 `/portal`。
- **WHEN** 用新建的测试账号 `tanghaonan` 登录 **THEN** 能进 `/portal`，只看到自己的租户；该账号的密码在数据库里是哈希，全文 grep 密码样本，代码和日志里都不出现。
- **WHEN** 管理员停用一个账号 **THEN** 该账号的会话立即失效，再登录被拒绝。
- **WHEN** 用老账号（唐浩南）的账号密码登录 **THEN** 能进测试用的页面；检查它的账号记录里没有绑手机号。
- **WHEN** 登录页里找手机号注册入口 **THEN** 找不到，只保留账号密码。

## 3. 租户隔离

- **WHEN** 建两个租户、两个账号，分别登录 **THEN** 各自的 Bot 列表、Ticket、审批、消耗都不一样，且互相看不到对方的。
- **WHEN** 直接查数据库 **THEN** Bot 表里的 `tenant_id` 和登录账号的 `tenant_id` 对得上。

## 4. 任意 Bot 接飞书

- **WHEN** 在 portal 的「消息平台」页里，给一个非管理 Bot（比如 dr eggbot）绑一个内部群 **THEN** 群里 @ 它，回话的是这个 Bot。
- **WHEN** 解绑之后群里再 @ **THEN** 机器人不回，且日志里有记录。
- **WHEN** 给同一个群绑第二个 Bot **THEN** 被拒绝或提示先解绑旧的；群里 @ 一次，只收到一条回复。
- **WHEN** 重启项目后查绑定 **THEN** 绑定还在；直接查数据库，绑定表里有 `bot_id`、`tenant_id`、`feishu_chat_id`、`chat_type`、`status`。
- **WHEN** 给同一个 Bot 绑两个群 **THEN** 两个群里 @ 都能回。
- **WHEN** 用一个不属于这个租户的群发消息 **THEN** 网关不转、不回，日志里有拒绝记录。
- **WHEN** A 租户改白名单 **THEN** B 租户的白名单不变。

## 5. 个人微信

- **WHEN** 在 portal 的「消息平台」页里，给一个 Bot 走个人微信 iLink 扫码绑定 **THEN** 私聊发消息，Bot 能回。
- **WHEN** 个人微信群里 @ 机器人 **THEN** 不承诺能回（iLink 机器人一般不能进普通微信群），页面上要写明“个人微信以私聊为主”。
- **WHEN** 企业微信（WeCom）入口 **THEN** 本次找不到，`WeComAdapter` 只有占位，不接通。

## 6. 常驻网关

- **WHEN** 项目启动时 **THEN** 网关跟着起来，不用手动开第三个终端跑 Python 脚本。
- **WHEN** 杀掉网关进程后 **THEN** systemd / launchd 能自动把它拉起来，portal 里网关状态从离线变回在线。
- **WHEN** 断网再连上 **THEN** 网关能自己重连，继续收消息，不丢消息或明确说明会丢多少。
- **WHEN** 手动跑的旧网关脚本和 `lark-cli` 还在跑 **THEN** 启动常驻网关前必须先停掉它们；同一个 App ID 有两个长连接消费者时，启动要报错或明确提示。

## 7. 中转 DeepSeek

- **WHEN** 停掉 / 卸载本地 `codex` / `claude` CLI 后，Bot 再回答 **THEN** 还能回，模型走中转 DeepSeek，不报错“找不到 CLI”。
- **WHEN** 检查 VM / 镜像 / 日志 **THEN** 中转站总 Key 不在 VM 里明文出现，不在代码里，不在 `code.img` 里。
- **WHEN** 中转站不可用时 **THEN** 控制面 LLM 代理按预算规则降级或熔断，Bot 不无限重试。
- **WHEN** 门口 Jev 快分流 **THEN** 走中转站的小模型，500 ms 超时回落到 lead bot 的规则不变。

## 8. 身份绑定

- **WHEN** 在 portal 里做一次飞书绑定 **THEN** 查数据库里有 `UserIdentity` 记录（`user_id`，`tenant_id`，`feishu_open_id`）；之后飞书群里审批，能对应回这个账号的用户。
- **WHEN** 用没绑定的飞书账号在群里 @ 或点审批 **THEN** 被拒绝或提示先绑定。
- **WHEN** 在 portal 里做一次个人微信绑定 **THEN** 查数据库里有 `WeixinIdentity` 记录，不和飞书的 `UserIdentity` 混在一张表里。

## 9. 明确不做的

- **WHEN** 在 `/portal` 里找飞书扫码登录入口 **THEN** 找不到，登录入口是账号密码。
- **WHEN** 在登录页里找手机号注册入口 **THEN** 找不到。
- **WHEN** 在 portal 里找企业微信入口 **THEN** 找不到，本次不做。
- **WHEN** 检查执行引擎 **THEN** 还是 OpenMausBot harness，不是 Hermes Agent（本次不换）。

## 10. 验收与归档

- **WHEN** `openspec validate --all --strict --no-interactive` 运行 **THEN** 全部通过。
- **WHEN** `tasks.md` 全部勾完 **THEN** `handoff.md` 写清基线、复用盘点、批准和下一步，再归档推送。
