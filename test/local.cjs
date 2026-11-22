const assert = require('node:assert')
const http = require('node:http')
const { App } = require('koishi')
const mockMod = require('@koishijs/plugin-mock')
const mock = mockMod.default || mockMod
const httpMod = require('@koishijs/plugin-http')
const httpPlugin = httpMod.default || httpMod
const plugin = require('../lib/index.js')
const render = require('../lib/render.js')

const TOKEN = 'test-token'
const HOUR = 3600 * 1000

let hits = { server: 0, service: 0, metrics: 0 }
let failServerTimes = 0
let rateLimitOnce = false

const servers = [
  {
    id: 1,
    name: '香港-01',
    last_active: new Date().toISOString(),
    state: {
      cpu: 12.3, mem_used: 1024 ** 3, disk_used: 5 * 1024 ** 3, uptime: 90061,
      net_in_transfer: 300 * 1024 ** 2, net_out_transfer: 200 * 1024 ** 2,
      net_in_speed: 2048, net_out_speed: 1024, swap_used: 0,
      load_1: 0.42, load_5: 0.21, load_15: 0.11, tcp_conn_count: 28, udp_conn_count: 7, process_count: 134,
    },
    host: {
      platform: 'Ubuntu', platform_version: '22.04', arch: 'x86_64',
      cpu: ['Xeon E5 @ 2.40GHz'], mem_total: 4 * 1024 ** 3, disk_total: 40 * 1024 ** 3,
      swap_total: 512 * 1024 ** 2, boot_time: 1786127253,
    },
    geoip: { country_code: 'HK' },
  },
  {
    id: 2,
    name: '东京-02',
    last_active: new Date(Date.now() - HOUR).toISOString(),
    state: { cpu: 88.8, mem_used: 3 * 1024 ** 3, disk_used: 30 * 1024 ** 3, uptime: 259200 },
    host: { platform: 'Debian', platform_version: '12', mem_total: 4 * 1024 ** 3, disk_total: 40 * 1024 ** 3 },
    geoip: { country_code: 'JP' },
  },
]

const metrics = Array.from({ length: 6 }, (_, i) => ({ ts: Date.now() - (5 - i) * HOUR, value: 10 + i * 5 }))

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const ok = (data) => send(200, { success: true, data })
  const fail = (code, error) => send(code, { success: false, error })

  if (rateLimitOnce) {
    rateLimitOnce = false
    return fail(429, 'too many requests')
  }
  if (req.headers.authorization !== 'Bearer ' + TOKEN) {
    if (req.headers.authorization === 'Bearer no-scope') return fail(403, 'missing scope nezha:inventory:read')
    return fail(401, 'unauthorized')
  }

  if (url.pathname === '/api/v1/setting') {
    return ok({ config: { site_name: '叹号の监控' } })
  }
  if (url.pathname === '/api/v1/server') {
    hits.server++
    if (failServerTimes > 0) {
      failServerTimes--
      return fail(500, 'boom')
    }
    if (url.searchParams.get('page') === '2') {
      return ok({ value: [servers[1]], pagination: { page: 2, total: 2 } })
    }
    if (url.searchParams.get('page') === '1' || url.searchParams.get('paged') === '1') {
      return ok({ value: [servers[0]], pagination: { page: 1, total: 2 } })
    }
    return ok(servers)
  }
  if (url.pathname === '/api/v1/service') {
    hits.service++
    return ok({
      services: {
        1: { service_name: '站点A', up: [100, 99, 98], down: [1], delay: [12.5, 20.1], current_up: 1, current_down: 0 },
        2: { service_name: '站点B', up: [50], down: [50], delay: [], current_up: 0, current_down: 1 },
      },
    })
  }
  if (url.pathname === '/api/v1/service/1/history') {
    return ok({
      service_id: 1,
      service_name: '站点A',
      servers: [{
        server_id: 1,
        server_name: '香港-01',
        stats: {
          total_up: 100, total_down: 2, avg_delay: 14.2, up_percent: 98.0,
          data_points: [
            { ts: Date.now() - 3 * HOUR, delay: 12.5, status: 1 },
            { ts: Date.now() - 2 * HOUR, delay: 18.2, status: 1 },
            { ts: Date.now() - HOUR, delay: 14.4, status: 1 },
          ],
        },
      }],
    })
  }
  if (url.pathname === '/api/v1/alert-rule') {
    return ok([{ id: 3, name: 'CPU 过高', enabled: true, servers: [1], rules: [{ type: 'cpu', min: 80, duration: 60 }] }])
  }
  if (url.pathname === '/api/v1/server/1/online-history') {
    return ok({ server_id: 1, server_name: '香港-01', days: 1, max_days: 7, online_rate: 99.5, total_online_seconds: 86040, currently_online: true, daily: [{ date: '2026-11-22', online_seconds: 86040 }] })
  }
  if (url.pathname === '/api/v1/server/1/service') {
    return ok({ services: { 1: { service_name: '站点A', up: [1], down: [], delay: [10], current_up: 1, current_down: 0 } } })
  }
  if (url.pathname === '/api/v1/service/1/server') {
    return ok([{ server_id: 1, server_name: '香港-01' }])
  }
  if (url.pathname === '/api/v1/server/1/metrics') {
    hits.metrics++
    return ok({ server_id: 1, metric: 'cpu', data_points: metrics })
  }
  if (url.pathname === '/api/v1/server/8/metrics') {
    return ok({ server_id: 8, metric: 'cpu', data_points: [] })
  }
  if (url.pathname === '/api/v1/server/9/metrics') {
    return fail(200, 'tsdb not enabled')
  }
  return send(404, { error: '404 Not Found' })
})

function makeApp(overrides = {}) {
  const app = new App()
  app.plugin(mock)
  app.plugin(httpPlugin)
  const config = {
    baseUrl: server.base,
    apiToken: TOKEN,
    adminToken: '',
    verifySSL: true,
    requestTimeout: 5,
    cacheTTL: 0,
    enableImage: false,
    renderTimeout: 5000,
    cdnBase: 'https://fastly.jsdelivr.net',
    showSiteName: true,
    pushTestAuthority: 0,
    userCooldown: 0,
    maxTextLength: 1800,
    debug: false,
    push: { enabled: false, interval: 30, channels: [], thresholdCpu: 90, thresholdMem: 90, thresholdDisk: 90, offline: true, cooldown: 30 },
    watch: { enabled: false, maxBackoff: 5 },
    ...overrides,
  }
  return { app, config }
}

async function boot(overrides = {}) {
  const { app, config } = makeApp(overrides)
  await app.start()
  app.plugin(plugin, config)
  await app.start()
  return app.mock.client('10001')
}

function pluginServer(raw) {
  return {
    id: raw.id, name: raw.name, online: true, cpu: raw.state.cpu,
    memUsed: raw.state.mem_used, memTotal: raw.host.mem_total,
    diskUsed: raw.state.disk_used, diskTotal: raw.host.disk_total,
    uptime: raw.state.uptime, platform: raw.host.platform, platformVersion: raw.host.platform_version,
    netInTransfer: raw.state.net_in_transfer || 0, netOutTransfer: raw.state.net_out_transfer || 0,
    lastActive: raw.last_active, geoipCountry: raw.geoip.country_code,
  }
}

const fakePage = {
  setViewport() {},
  async setContent() {},
  async screenshot() { return Buffer.from('fake-png') },
  async close() {},
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.base = 'http://127.0.0.1:' + server.address().port

  console.log('1. 插件元信息')
  assert.strictEqual(plugin.name, 'nezha')
  assert.deepStrictEqual(plugin.inject, { required: ['http'], optional: ['puppeteer'] })
  assert.ok(plugin.Config, 'Config 缺失')

  console.log('2. 状态（文字）')
  const client = await boot()
  let replies = await client.receive('nezha 状态')
  let text = replies.join('\n')
  assert.ok(text.includes('香港-01') && text.includes('东京-02'), '服务器列表缺失: ' + text)
  assert.ok(text.includes('在线 1') && text.includes('离线 1'), '在线统计错误: ' + text)
  assert.ok(text.includes('CPU 12.3%'), 'CPU 未格式化: ' + text)

  console.log('3. 详情（v2 字段）')
  replies = await client.receive('nezha 详情 1')
  text = replies.join('')
  assert.ok(text.includes('Ubuntu 22.04') && text.includes('运行时间：1天'), '详情内容缺失: ' + text)
  assert.ok(text.includes('核心数：1'), '核心数没从 host.cpu 取: ' + text)
  assert.ok(text.includes('负载：0.42 / 0.21 / 0.11'), '负载缺失: ' + text)
  assert.ok(text.includes('TCP 28') && text.includes('进程 134'), '连接/进程缺失: ' + text)
  assert.ok(text.includes('↓ 2.00 KB/s'), '速率换算错误: ' + text)

  console.log('4. 详情 ID 不存在')
  assert.ok((await client.receive('nezha 详情 99')).join('').includes('未找到 ID 为 99'))

  console.log('5. 服务列表（current_* 计数判定）')
  replies = await client.receive('nezha 服务')
  text = replies.join('\n')
  assert.ok(text.includes('站点A') && text.includes('站点B'), '服务列表缺失: ' + text)
  assert.ok(text.includes('🔴 站点B'), '离线判定错误: ' + text)
  assert.ok(text.includes('可用率 99.66%'), '可用率计算错误: ' + text)

  console.log('6. 服务详情')
  replies = await client.receive('nezha 服务详情 1')
  text = replies.join('')
  assert.ok(text.includes('站点A') && text.includes('总可用率：98.04%'), '服务详情缺失: ' + text)

  console.log('7. 历史指标')
  replies = await client.receive('nezha 历史 1 cpu 1d')
  text = replies.join('')
  assert.ok(text.includes('CPU 使用率') && text.includes('当前：'), '历史文本缺失: ' + text)

  console.log('8. 参数校验')
  assert.ok((await client.receive('nezha 历史 1 nope')).join('').includes('不支持的指标'))
  assert.ok((await client.receive('nezha 历史 1 cpu 9d')).join('').includes('不支持的周期'))
  assert.ok((await client.receive('nezha 历史 1')).join('').includes('用法'))

  console.log('9. 空指标给 TSDB 提示')
  assert.ok((await client.receive('nezha 历史 8 cpu 1d')).join('').includes('TSDB'), '空指标没提示')
  assert.ok((await client.receive('nezha 历史 9 cpu 1d')).join('').includes('TSDB'), 'tsdb 错误没透传')

  console.log('10. 认证 / 权限 / 限流')
  const bad = await boot({ apiToken: 'wrong' })
  const badText = (await bad.receive('nezha 状态')).join('')
  assert.ok(badText.includes('认证失败') && badText.includes('nzp_'), '认证提示不足: ' + badText)
  const noScope = await boot({ apiToken: 'no-scope' })
  const scopeText = (await noScope.receive('nezha 状态')).join('')
  assert.ok(scopeText.includes('权限不足') && scopeText.includes('白名单'), '403 提示不足: ' + scopeText)
  hits.server = 0
  rateLimitOnce = true
  assert.ok((await client.receive('nezha 状态')).join('\n').includes('香港-01'), '429 后重试失败')

  console.log('11. 连不上面板')
  const down = await boot({ baseUrl: 'http://127.0.0.1:1' })
  assert.ok((await down.receive('nezha 状态')).join('').includes('无法连接'))

  console.log('12. 出图 + 站点名')
  const img = makeApp({ enableImage: true })
  img.app.puppeteer = { page: async () => fakePage }
  await img.app.start()
  img.app.plugin(plugin, img.config)
  await img.app.start()
  const imgReplies = await img.app.mock.client('10001').receive('nezha 状态')
  assert.ok(imgReplies.join('').includes('<img'), '没出图')

  console.log('13. 出图失败降级文字')
  const broken = makeApp({ enableImage: true })
  broken.app.puppeteer = { page: async () => { throw new Error('no browser') } }
  await broken.app.start()
  broken.app.plugin(plugin, broken.config)
  await broken.app.start()
  const brokenText = (await broken.app.mock.client('10001').receive('nezha 状态')).join('')
  assert.ok(brokenText.includes('香港-01') && !brokenText.includes('<img'), '降级失败')

  console.log('14. 服务器列表缓存')
  hits.server = 0
  const cached = await boot({ cacheTTL: 60 })
  await cached.receive('nezha 状态')
  await Promise.all([cached.receive('nezha 详情 1'), cached.receive('nezha 详情 2')])
  assert.strictEqual(hits.server, 1, '缓存未生效: ' + hits.server)

  console.log('15. 500 重试')
  hits.server = 0
  failServerTimes = 2
  assert.ok((await client.receive('nezha 状态')).join('\n').includes('香港-01'), '重试后仍失败')
  assert.strictEqual(hits.server, 3, '重试次数不对: ' + hits.server)

  console.log('16. 分页列表兜底')
  hits.server = 0
  const paged = await boot()
  const pagedText = (await paged.receive('nezha 状态')).join('\n')
  assert.ok(pagedText.includes('东京-02') || pagedText.includes('香港-01'), '分页列表为空')

  console.log('17. 模板渲染')
  const config = { cdnBase: 'https://fastly.jsdelivr.net', enableImage: false, maxTextLength: 1800 }
  render.resetRenderCache()
  const renderCtx = { http: { get: async () => { throw new Error('offline') } }, logger: { debug() {}, warn() {}, error() {} } }
  const html = await render.buildHtml(renderCtx, config, 'status', render.statusData(servers.map(pluginServer)))
  assert.ok(html.includes('香港-01'), '模板没渲染出服务器名')
  assert.ok(!/\{\{|\{%/.test(html), '模板标签没被替换完')
  assert.ok(html.includes('哪吒监控'), '站点名默认值缺失')
  assert.ok(html.includes('🇭🇰'), 'CDN 不可用时没回退 emoji 国旗')
  assert.ok(html.includes('fl-ubuntu'), '系统图标缺失')
  const detailHtml = await render.buildHtml(renderCtx, config, 'server_detail', render.detailData({ ...pluginServer(servers[0]), cpuCores: 1, load1: 0.42, load5: 0.21, load15: 0.11, tcpConn: 28, udpConn: 7, processCount: 134, arch: 'x86_64', bootTime: 1786127253, netInSpeed: 2048, netOutSpeed: 1024, swapUsed: 0, swapTotal: 536866816 }))
  assert.ok(detailHtml.includes('0.42 / 0.21 / 0.11'), '负载没进模板')
  assert.ok(detailHtml.includes('data:image/png;base64,'), 'logo 没内联')

  console.log('18. 告警 / 在线率 / 关联查询')
  const alertText = (await client.receive('nezha 告警')).join('')
  assert.ok(alertText.includes('CPU 过高') && alertText.includes('CPU ≥ 80'), '告警规则缺失: ' + alertText)
  const rateText = (await client.receive('nezha 在线率 1')).join('')
  assert.ok(rateText.includes('99.50%') && rateText.includes('小时'), '在线率缺失: ' + rateText)
  const ssText = (await client.receive('nezha 关联服务 1')).join('')
  assert.ok(ssText.includes('站点A'), '服务器关联服务缺失')
  const vsText = (await client.receive('nezha 服务服务器 1')).join('')
  assert.ok(vsText.includes('香港-01'), '服务关联服务器缺失')

  console.log('19. 告警对象渲染 / 限流 / 推送测试')
  const ruleText = (await client.receive('nezha 告警')).join('')
  assert.ok(ruleText.includes('CPU ≥ 80') && ruleText.includes('持续 60s'), '告警条件没解析: ' + ruleText)
  assert.ok(ruleText.includes('香港-01'), '告警对象没换成名字: ' + ruleText)

  const slow = await boot({ userCooldown: 2 })
  await slow.receive('nezha 状态')
  assert.ok((await slow.receive('nezha 状态')).join('').includes('慢一点'), '限流没生效')

  const pushApp = makeApp({ push: { enabled: false, interval: 30, channels: ['mock:20001'], thresholdCpu: 90, thresholdMem: 90, thresholdDisk: 90, offline: true, cooldown: 30 } })
  await pushApp.app.start()
  pushApp.app.plugin(plugin, pushApp.config)
  await pushApp.app.start()
  const sent = []
  pushApp.app.bots[0].sendMessage = async (channel, content) => { sent.push([channel, content]); return content }
  const pushClient = pushApp.app.mock.client('10001')
  await pushClient.receive('nezha 推送测试')
  assert.ok(
    sent.some(([channel, content]) => channel === '20001' && JSON.stringify(content).includes('推送测试')),
    '推送测试没发: ' + JSON.stringify(sent),
  )
  sent.length = 0
  await pushClient.receive('nezha 推送测试 mock:999:123')
  assert.ok(sent.some(([channel]) => channel === '123'), '指定频道没生效: ' + JSON.stringify(sent))

  console.log('20. 概览 / 服务延迟曲线')
  const overview = (await client.receive('nezha 概览')).join('\n')
  assert.ok(overview.includes('香港-01') && overview.includes('24h 在线率'), '概览不完整: ' + overview)
  const svcDetail = (await client.receive('nezha 服务详情 1')).join('\n')
  assert.ok(svcDetail.includes('延迟') && svcDetail.includes('ms'), '服务延迟曲线没出: ' + svcDetail)

  console.log('21. 帮助')
  assert.ok((await client.receive('nezha 帮助')).join('').includes('nezha 状态'))

  console.log('22. 长文本分片')
  const short = await boot({ maxTextLength: 120 })
  const parts = await short.receive('nezha 状态')
  assert.ok(parts.length > 1, '未分片')
  assert.ok(parts.every((part) => part.length <= 400), '分片超长')

  await new Promise((resolve) => server.close(resolve))
  console.log('\nALL TESTS PASSED')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})