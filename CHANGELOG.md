# 变更记录

## 1.0.3

- 国旗改为内置 SVG（`assets/flags`）并内联成 data URI，不再依赖 jsDelivr：断外网、被墙都不再退化成蓝色「US/HK/CN」字母块
- 系统图标字体（`font-logos`）同样内置，缺字体时不再丢图标
- 取不到国家代码时用联合国旗兜底；纯文本输出的 emoji 国旗改为按 ISO 代码合成，覆盖所有国家
- 状态卡去掉「总计」的 🖥️ emoji，在线/离线前的圆点改成 CSS 实心圆（不再依赖字体字形）
- 去掉 `cdnBase` 配置项（资源全部内置，不再需要镜像）
- 对照上游 2.8.1 复核 API：无读取接口变化，无需适配

## 1.0.2

- README 标注「AI 生成」并补上交流群

## 1.0.1

> npm 上 `koishi-plugin-nezha` 的 1.0.0 曾于 2024 年被发布后又下架，版本号不可复用，首发改用 1.0.1。


- `apiToken` 改为可选，支持游客模式；被 `force_auth` 拒绝时提示去填 Token
- 新增 `locale`（zh-CN / en-US），文字输出与帮助/报错跟随语言；卡片模板仍为中文
- 依赖升到 latest，锁文件重新生成
- 首发 1.0.0：命令、推送、实时流、告警、在线率、延迟曲线功能齐备

## 0.2.1

- 告警规则按对象解析（`type/min/max/duration`）并显示服务器名，不再是 `[object Object]`
- 出图加 2 并发上限，超出的排队
- 推送频道支持 `platform[:selfId]:channelId`，可用 `nezha 推送测试` 验证
- 国旗样式探测失败时回退 emoji 国旗
- 每用户查询冷却 `userCooldown`；401/403/429 等预期错误降为 warn
- 新增 `nezha 概览`（状态 + 24h 在线率）、服务详情附延迟曲线
- 删掉未使用的 `adminToken`

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