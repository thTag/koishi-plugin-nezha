# koishi-plugin-nezha

在 Koishi 里查询[哪吒监控](https://github.com/nezhahq/nezha)（Nezha）面板：服务器状态、单机详情、服务监控、历史指标趋势，结果渲染成卡片图。

> 移植自 AstrBot 插件 [astrbot_plugin_nezhatz](https://github.com/thTag/astrbot_plugin_nezhatz)，感谢原作者。
> 本插件与哪吒监控官方无关，只是面板 REST API 的客户端；面板要你自己部署。

## 功能

| 命令 | 说明 |
|---|---|
| `nezha 状态` | 服务器状态概览（CPU / 内存 / 磁盘），在线与离线分开统计 |
| `nezha 详情 <ID>` | 单台服务器完整信息（系统、负载、流量、运行时间） |
| `nezha 服务` | 服务监控列表（可用率 / 延迟 / 当前状态） |
| `nezha 服务详情 <ID>` | 单个服务监控的明细（各服务器可用率、延迟） |
| `nezha 历史 <ID> <指标> [周期]` | 历史趋势折线图，周期 `1d` / `7d` / `30d` |
| `nezha 帮助` | 用法 |

英文别名：`status` / `detail` / `service` / `service-detail` / `history` / `help`。

指标：`cpu`、`memory`、`swap`、`disk`、`net_in_speed`、`net_out_speed`、`net_in_transfer`、`net_out_transfer`、`load1`、`load5`、`load15`、`tcp_conn`、`udp_conn`、`process_count`、`temperature`、`uptime`、`gpu`。

## 前置要求

1. 一个可访问的哪吒面板（v1 API），本插件请求 `/api/v1/*`
2. 在面板后台生成 **API Token（PAT）**，至少给 `nezha:server:read`、`nezha:service:read`；建议只给这个 Token 勾选需要的服务器白名单
3. `nezha 历史` 需要面板开启 **TSDB**（TimescaleDB），否则面板会返回错误

## 安装

```bash
# 尚未发布到 npm，先按仓库安装
yarn add https://github.com/thTag/koishi-plugin-nezha
```

想要卡片图就再装 `koishi-plugin-puppeteer`（并保证容器里有 Chromium 和中文字体）；不装也能用，会自动发文字。

## 配置

```yaml
plugins:
  nezha:
    baseUrl: https://nezha.example.com:8008   # 面板地址（必填）
    apiToken: xxxxxxxx                        # 面板 API Token（必填）
    adminToken: ''                            # 管理员 Token，预留
    verifySSL: true                           # 自签证书报错时改 false
    requestTimeout: 30                        # 请求超时（秒）
    cacheTTL: 30                              # 服务器列表缓存（秒），0 = 不缓存
    enableImage: true                         # 出卡片图，需 puppeteer
    renderTimeout: 30000                      # 出图超时（毫秒）
    cdnBase: https://fastly.jsdelivr.net      # 模板里国旗/系统图标的 CDN，可换镜像
    maxTextLength: 1800                       # 单条文字上限
    debug: false
```

## 出图与降级

5 个页面各有一套 HTML 模板（`templates/`，沿用自 AstrBot 版），走 puppeteer 截图；页码、国旗、系统图标由 `flag-icons` / `font-logos` 两个 CDN 样式提供：

- 装没装 puppeteer、浏览器启不来、截图超时——一律记一条 warn 后改发文字，不会卡住命令
- 面板在纯内网、Bot 服务器出不了网时，国旗和系统图标会缺；其余布局正常，可用 `cdnBase` 指到自己的镜像
- logo 已内联进包（`assets/logo.png`），不依赖 GitHub

## 安全提醒

- `apiToken` 明文存在 Koishi 配置里，别把配置文件外传
- 只勾选必需权限和服务器白名单，Token 泄露时可单删
- 插件不会主动输出 Token；`debug` 日志只打印路径，不带 Authorization 头

## 开发

```shell
npm i
npm run typecheck
npm test          # 离线：本地 mock 哪吒 API + 真实 Koishi App，覆盖出图与文字降级
npm run build && npm pack
```

模板是极简 Jinja 子集（见 `src/template.ts`），改版式直接改 `templates/*.html`，支持 `{{ }}`、`{% if %}`、`{% for %}`、`{% set %}` 和 `default/length/format` 过滤器。

## License

MIT
