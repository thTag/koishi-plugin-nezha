# 变更记录

## 0.1.0

首个版本，从 [astrbot_plugin_nezhatz](https://github.com/thTag/astrbot_plugin_nezhatz) 移植：

- `nezha 状态` / `详情 <id>` / `服务` / `服务详情 <id>` / `历史 <id> <指标> [周期]`
- 复用原插件的 5 套 HTML 模板（含 CSS），装了 `koishi-plugin-puppeteer` 直接出图，没装自动降级文字
- 服务器列表 30 秒缓存 + 指数退避重试（3 次）
- 401 / 超时 / 连不上 / 5xx / TSDB 未启用等错误给出可照做的提示
- 自带离线测试：本地 mock 哪吒 API + 真实 Koishi App
