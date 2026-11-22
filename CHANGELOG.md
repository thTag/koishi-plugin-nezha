# 变更记录

## 0.2.0

按面板 v2.7 的 API 做兼容层，并补上上游插件的 TODO：

- 兼容 v2 的 `{ success, data }` 信封与纯 `{ error }`、分页列表（`value/pagination`）
- 401 / 403 / 429 分开提示，403 说清缺 scope 还是白名单；429 自动退避重试一次
- 指标为空时读 `/api/v1/setting` 的 `tsdb_enabled`，区分「TSDB 未启用」与「周期内无数据」
- 详情卡新增架构、核心数（`host.cpu` 长度）、1/5/15 负载、TCP/UDP 连接、进程数、Swap、进出速率、启动时间
- 新增 `nezha 告警`、`nezha 在线率`、`nezha 关联服务`、`nezha 服务服务器`
- 新增定时推送 + 阈值/离线告警（冷却、恢复提醒），新增 WebSocket 实时状态流（断线退避重连）
- 卡片标题改用面板 `site_name`（`showSiteName` 可关）
- 服务在线状态改按下线探测占比判定（v2 的 `current_*` 是计数）
- 新增 `npm run test:live`（`NEZHA_BASE`/`NEZHA_TOKEN`）；离线测试补 403/429/分页/空指标

## 0.1.0

首个版本，从 astrbot_plugin_nezhatz 移植。
