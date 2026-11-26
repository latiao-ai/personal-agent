## ADDED Requirements

### Requirement: 飞书私聊有来有回

网关 MUST 将获准的私聊转给固定 Bot，并把回复发回原私聊。

#### Scenario: 私聊发“你好”
- **WHEN** 白名单里的人在飞书私聊发“你好”
- **THEN** 网关在 5 秒内收到该消息，并转给固定 Bot；Bot 回一句话，飞书私聊上能看到

#### Scenario: 私聊发 3 句话
- **WHEN** 白名单里的人在飞书私聊连续发 3 句话
- **THEN** 3 句都有回复，不丢、不乱序

### Requirement: 陌生人默认拒绝

网关 MUST 拒绝白名单外的发送者，记录拒绝，不回复、不生成 Ticket。

#### Scenario: 陌生人发消息
- **WHEN** 白名单外的人私聊 bot 发一句话
- **THEN** 网关拒绝该消息，不转发、不生成工单、不回复；日志里有一条拒绝记录

### Requirement: 重启不重复回

网关 MUST 在重启后识别已处理消息，避免重复回复。

#### Scenario: 重启后不重发
- **WHEN** 网关重启
- **THEN** 之前已收到的消息不重复回；重启后新发的私聊消息能正常收发

### Requirement: 断线自动重连

网关 MUST 自动恢复出站 WebSocket 长连接，无需公网地址或域名。

#### Scenario: 断网恢复
- **WHEN** 网络断开后再恢复
- **THEN** 网关自动重连，恢复收消息，不需要手动重启

### Requirement: 回归——原有功能不受影响

适配器 MUST 保持原有聊天、审批卡片和连接器行为。

#### Scenario: 原有 bot 照常用
- **WHEN** 网关 change 做完
- **THEN** 原有 bot 的聊天、审批卡片、连接器照常用；只加适配器，不改核心 bot 逻辑、记忆与 harness 服务
