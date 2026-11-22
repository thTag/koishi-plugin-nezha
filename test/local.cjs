const assert = require('node:assert')
const http = require('node:http')
const { App } = require('koishi')
const mockMod = require('@koishijs/plugin-mock')
const mock = mockMod.default || mockMod
const httpMod = require('@koishijs/plugin-http')
const httpPlugin = httpMod.default || httpMod
const plugin = require('../lib/index.js')

const TOKEN = 'test-token'
const HOUR = 3600 * 1000

let hits = { server: 0, service: 0, metrics: 0 }
let failServerTimes = 0

const servers = [
  {
    id: 1,
    name: '香港-01',
    last_active: new Date().toISOString(),
    state: { cpu: 12.3, mem_used: 1024 ** 3, disk_used: 5 * 1024 ** 3, uptime: 90061, net_in_transfer: 300 * 1024 ** 2, net_out_transfer: 200 * 1024 ** 2 },
    host: { platform: 'Ubuntu', platform_version: '22.04', mem_total: 4 * 1024 ** 3, disk_total: 40 * 1024 ** 3 },
    geoip: { country_code: 'HK' },
  },
  {
    id: 2,
    name: '东京-02',
    last_active: new Date(Date.now() - HOUR).toISOString(),
    state: { cpu: 88.8, mem_used: 3 * 1024 ** 3, disk_used: 30 * 1024 ** 3, uptime: 259200, net_in_transfer: 0, net_out_transfer: 0 },
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
  if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'unauthorized' })

  if (url.pathname === '/api/v1/server') {
    hits.server++
    if (failServerTimes > 0) {
      failServerTimes--
      return send(500, { error: 'boom' })
    }
    return send(200, { data: servers })
  }
  if (url.pathname === '/api/v1/service') {
    hits.service++
    return send(200, {
      data: {
        services: {
          1: { service_name: '站点A', up: [100, 99, 98], down: [1], delay: [12.5, 20.1], current_up: 1, current_down: 0 },
          2: { service_name: '站点B', up: [50], down: [50], delay: [], current_up: 0, current_down: 1 },
        },
      },
    })
  }
  if (url.pathname === '/api/v1/service/1/history') {
    return send(200, {
      data: {
        service_name: '站点A',
        servers: [{ server_name: '香港-01', stats: { total_up: 100, total_down: 2, avg_delay: 14.2, up_percent: 98.0 } }],
      },
    })
  }
  if (url.pathname === '/api/v1/server/1/metrics') {
    hits.metrics++
    return send(200, { data: { data_points: metrics } })
  }
  if (url.pathname === '/api/v1/server/9/metrics') {
    return send(200, { error: 'tsdb not enabled' })
  }
  return send(404, { error: 'not found' })
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
    maxTextLength: 1800,
    debug: false,
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

const fakePage = {
  setViewport() {},
  async setContent() {},
  async screenshot() { return Buffer.from('fake-png') },
  async close() {},
}

function pluginServer(raw) {
  return {
    id: raw.id, name: raw.name, online: true, cpu: raw.state.cpu,
    memUsed: raw.state.mem_used, memTotal: raw.host.mem_total,
    diskUsed: raw.state.disk_used, diskTotal: raw.host.disk_total,
    uptime: raw.state.uptime, platform: raw.host.platform, platformVersion: raw.host.platform_version,
    netInTransfer: raw.state.net_in_transfer, netOutTransfer: raw.state.net_out_transfer,
    lastActive: raw.last_active, geoipCountry: raw.geoip.country_code,
  }
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

  console.log('3. 详情')
  replies = await client.receive('nezha 详情 1')
  text = replies.join('')
  assert.ok(text.includes('Ubuntu 22.04') && text.includes('运行时间：1天'), '详情内容缺失: ' + text)
  assert.ok(text.includes('1.00 GB / 4.00 GB'), '内存格式化错误: ' + text)

  console.log('4. 详情 ID 不存在')
  replies = await client.receive('nezha 详情 99')
  assert.ok(replies.join('').includes('未找到 ID 为 99'), '未提示不存在')

  console.log('5. 服务列表')
  replies = await client.receive('nezha 服务')
  text = replies.join('\n')
  assert.ok(text.includes('站点A') && text.includes('站点B'), '服务列表缺失: ' + text)
  assert.ok(text.includes('连接正常') || text.includes('🟢'), '状态标记缺失')
  assert.ok(text.includes('可用率 99.66%'), '可用率计算错误: ' + text)

  console.log('6. 服务详情')
  replies = await client.receive('nezha 服务详情 1')
  text = replies.join('')
  assert.ok(text.includes('站点A') && text.includes('总可用率：98.04%'), '服务详情缺失: ' + text)
  assert.ok(text.includes('平均延迟：14.2ms'), '延迟格式化错误')

  console.log('7. 历史指标')
  replies = await client.receive('nezha 历史 1 cpu 1d')
  text = replies.join('')
  assert.ok(text.includes('CPU 使用率') && text.includes('当前：'), '历史文本缺失: ' + text)
  assert.ok(text.includes('过去24小时'), '周期标签缺失')

  console.log('8. 参数校验')
  assert.ok((await client.receive('nezha 历史 1 nope')).join('').includes('不支持的指标'))
  assert.ok((await client.receive('nezha 历史 1 cpu 9d')).join('').includes('不支持的周期'))
  assert.ok((await client.receive('nezha 历史 1')).join('').includes('用法'))
  assert.ok((await client.receive('nezha 详情')).join('').includes('请指定服务器 ID'))

  console.log('9. 认证失败')
  const bad = await boot({ apiToken: 'wrong' })
  const badText = (await bad.receive('nezha 状态')).join('')
  assert.ok(badText.includes('认证失败') && badText.includes('nezha:server:read'), '认证错误提示不足: ' + badText)

  console.log('10. 连不上面板')
  const down = await boot({ baseUrl: 'http://127.0.0.1:1' })
  const downText = (await down.receive('nezha 状态')).join('')
  assert.ok(downText.includes('无法连接'), '连接失败提示缺失: ' + downText)

  console.log('11. TSDB 未启用')
  const tsdb = (await client.receive('nezha 历史 9 cpu 1d')).join('')
  assert.ok(tsdb.includes('TSDB 未启用'), 'TSDB 提示缺失: ' + tsdb)

  console.log('12. 出图')
  const img = makeApp({ enableImage: true })
  img.app.puppeteer = { page: async () => fakePage }
  await img.app.start()
  img.app.plugin(plugin, img.config)
  await img.app.start()
  const imgClient = img.app.mock.client('10001')
  const imgReplies = await imgClient.receive('nezha 状态')
  assert.ok(imgReplies.join('').includes('<img'), '没出图: ' + imgReplies.join('').slice(0, 120))

  console.log('13. 出图失败降级文字')
  const broken = makeApp({ enableImage: true })
  broken.app.puppeteer = { page: async () => { throw new Error('no browser') } }
  await broken.app.start()
  broken.app.plugin(plugin, broken.config)
  await broken.app.start()
  const brokenText = (await broken.app.mock.client('10001').receive('nezha 状态')).join('')
  assert.ok(brokenText.includes('香港-01') && !brokenText.includes('<img'), '降级失败: ' + brokenText.slice(0, 120))

  console.log('14. 服务器列表缓存')

  hits.server = 0
  const cached = await boot({ cacheTTL: 60 })
  await cached.receive('nezha 状态')
  await Promise.all([cached.receive('nezha 详情 1'), cached.receive('nezha 详情 2')])
  assert.strictEqual(hits.server, 1, '缓存未生效，请求 ' + hits.server + ' 次')

  console.log('15. 500 重试')
  hits.server = 0
  failServerTimes = 2
  const retryText = (await client.receive('nezha 状态')).join('\n')
  assert.ok(retryText.includes('香港-01'), '重试后仍失败: ' + retryText)
  assert.strictEqual(hits.server, 3, '重试次数不对: ' + hits.server)

  console.log('16. 模板渲染')
  const render = require('../lib/render.js')
  const config = { cdnBase: 'https://fastly.jsdelivr.net', enableImage: false, maxTextLength: 1800 }
  const html = await render.buildHtml(config, 'status', render.statusData(servers.map((raw) => pluginServer(raw))))
  assert.ok(html.includes('香港-01'), '模板没渲染出服务器名')
  assert.ok(!/\{\{|\{%/.test(html), '模板标签没被替换完')
  assert.ok(html.includes('fi-hk'), '国旗 class 缺失')
  assert.ok(html.includes('fl-ubuntu'), '系统图标 class 缺失')
  const detailHtml = await render.buildHtml(config, 'server_detail', render.detailData(pluginServer(servers[0])))
  assert.ok(detailHtml.includes('1.00 GB / 4.00 GB'), '详情模板数据没进去')
  assert.ok(detailHtml.includes('data:image/png;base64,'), 'logo 没内联')

  console.log('17. 帮助')
  assert.ok((await client.receive('nezha 帮助')).join('').includes('nezha 状态'))

  console.log('18. 长文本分片')
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