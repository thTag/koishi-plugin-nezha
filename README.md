# koishi-plugin-nezha

> 🤖 **本插件由 AI 生成**：代码、文档与测试均由 AI 产出，作者负责提需求与验收。
> 💬 欢迎加入叹号のBot小窝：**1065333145** —— <https://qm.qq.com/q/292RK9sYDK>

在 Koishi 里查询[哪吒监控](https://github.com/nezhahq/nezha)（Nezha V2）面板：服务器状态、单机详情、服务监控、在线率、告警规则与历史指标，结果渲染成卡片图。

> 移植自 AstrBot 插件 [astrbot_plugin_nezhatz](https://github.com/thTag/astrbot_plugin_nezhatz)，并按面板 v2.7 的 API 重写过兼容层。
> 与哪吒监控官方无关，只是面板 REST API 的客户端；面板要你自己部署。

## 兼容性

- 适配面板 V2 的 `/api/v1`：`{ success, data }` 信封、`Bearer nzp_…` PAT、失败时 `{ success:false, error }`
- 服务器列表同时兼容数组与分页（`value/pagination`）两种返回
- 401 / 403 / 429 分开提示；403 直接说清是缺 scope 还是服务器不在白名单
- 指标为空时结合 `/api/v1/setting` 的 `tsdb_enabled` 区分「TSDB 未启用」和「这个周期没数据」
- 面板 V1（`/api/v1/server` 老形状）没有 `state.load_*` 等字段时会退化成 0，不会报错

## 功能

| 命令 | 说明 |
|---|---|
| `nezha 状态` | 服务器状态概览（CPU / 内存 / 磁盘），在线与离线分开统计 |
| `nezha 概览` | 状态卡 + 前几台的 24h 在线率，一屏看完 |
| `nezha 详情 <ID>` | 单机完整信息：系统、架构、核心数、负载、连接、进程、Swap、速率、流量、运行时间 |
| `nezha 服务` | 服务监控列表（可用率 / 延迟 / 当前状态） |
| `nezha 服务详情 <ID>` | 单个服务监控的明细 |
| `nezha 历史 <ID> <指标> [周期]` | 历史趋势折线图，周期 `1d` / `7d` / `30d` |
| `nezha 在线率 <ID> [天数]` | 在线率与按天在线时长（走数据库，不依赖 TSDB） |
| `nezha 告警` | 面板里的告警规则列表 |
| `nezha 关联服务 <ID>` | 这台服务器上的服务监控 |
| `nezha 服务服务器 <ID>` | 该服务监控覆盖的服务器 |
| `nezha 推送测试 [频道]` | 往推送频道发一条测试消息 |
| `nezha 帮助` | 用法 |

英文别名：`status` / `detail` / `service` / `service-detail` / `history` / `uptime` / `alert` / `server-services` / `service-servers`。

指标：`cpu`、`memory`、`swap`、`disk`、`net_in_speed`、`net_out_speed`、`net_in_transfer`、`net_out_transfer`、`load1`、`load5`、`load15`、`tcp_conn`、`udp_conn`、`process_count`、`temperature`、`uptime`、`gpu`。

### 定时推送

`push.enabled` 打开后按 `push.interval` 分钟把概览发到 `push.channels`（格式 `platform:channelId`），并在越过阈值时加告警行：

- CPU / 内存 / 磁盘阈值（`thresholdCpu` / `thresholdMem` / `thresholdDisk`，0 关闭）
- 离线告警（`push.offline`），恢复时补一条
- 同一告警有 `push.cooldown` 分钟冷却，避免刷屏
- 频道格式 `platform[:selfId]:channelId`；配好多半是错的，先 `nezha 推送测试` 验一条（默认要权限 3，`pushTestAuthority` 可调）

### 实时状态流

`watch.enabled` 打开后订阅 `/api/v1/ws/server`，把快照写进缓存（后续命令看到的是秒级数据），断线指数退避重连，上限 `watch.maxBackoff` 秒。

## 前置要求

1. 可访问的面板 V2
2. 在面板「设置 → API Tokens」建 PAT，至少给 `nezha:inventory:read`、`nezha:server:read`、`nezha:service:read`；告警列表另需 `nezha:alertrule:read`；建议填服务器 ID 白名单
3. `apiToken` 留空是游客模式，只有面板没开 `force_auth` 时才够用
3. `nezha 历史` 需要面板开启 TSDB（TimescaleDB）

## 安装

```bash
# 尚未发布到 npm，先按仓库安装
yarn add https://github.com/thTag/koishi-plugin-nezha
```

想要卡片图就再装 `koishi-plugin-puppeteer`（并保证容器里有 Chromium 和中文字体）；不装也能用，自动发文字。

## 配置

```yaml
plugins:
  nezha:
    baseUrl: https://nezha.example.com:8008   # 面板地址（必填）
    apiToken: nzp_xxxxxxxx                    # 面板 API Token；留空 = 游客模式（force_auth 时不行）
    locale: zh-CN                             # 文字输出语言：zh-CN / en-US（卡片模板固定中文）
    verifySSL: true                           # 自签证书报错时改 false
    requestTimeout: 30                        # 请求超时（秒）
    cacheTTL: 30                              # 服务器列表缓存（秒），0 = 不缓存
    watch:
      enabled: false                          # 实时状态流
      maxBackoff: 30
    push:
      enabled: false
      interval: 30                            # 间隔（分钟）
      channels: ['onebot:123456']             # platform:channelId
      thresholdCpu: 90
      thresholdMem: 90
      thresholdDisk: 90
      offline: true
      cooldown: 30
    enableImage: true                         # 出卡片图，需 puppeteer
    renderTimeout: 30000
    cdnBase: https://fastly.jsdelivr.net      # 国旗/系统图标 CDN，可换镜像
    showSiteName: true                        # 标题用面板站点名
    pushTestAuthority: 3                      # 推送测试所需权限
    userCooldown: 3                           # 同一用户查询冷却（秒）
    maxTextLength: 1800
    debug: false
```

## 出图与降级

5 个页面各有一套 HTML 模板（`templates/`），走 puppeteer 截图；国旗、系统图标由 `flag-icons` / `font-logos` 两个 CDN 样式提供：

- 没装 puppeteer、浏览器起不来、截图超时——记一条 warn 后改发文字，不会卡住命令
- 国旗样式探测失败（内网/断外网）时自动退回 emoji 国旗；系统图标仍会缺，`cdnBase` 可指到自己的镜像
- 进度条按官方 70 / 90 阈值：绿→黄→红，交界 ±3 内做渐变
- logo 已内联进包（`assets/logo.png`），不依赖 GitHub

## 安全提醒

- `apiToken` 明文存在 Koishi 配置里，别外传配置文件
- 只给必需 scope 并设白名单，泄露时直接吊销该 Token
- 插件不会输出 Token；`debug` 日志只打请求路径，不带 Authorization 头

## 开发

```shell
npm i
npm run typecheck
npm test                                          # 离线：本地 mock 面板 + 真实 Koishi App
NEZHA_BASE=https://你的面板 NEZHA_TOKEN=nzp_xxx npm run test:live   # 打真面板
npm run build && npm pack
```

模板是极简 Jinja 子集（见 `src/template.ts`），改版式直接改 `templates/*.html`，支持 `{{ }}`、`{% if %}`、`{% for %}`、`{% set %}` 和 `default/length/format` 过滤器。

## License

MIT