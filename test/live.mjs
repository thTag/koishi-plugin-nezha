import assert from 'node:assert'
import { NezhaApi } from '../lib/api.js'
import { detailData, serviceListData, statusData } from '../lib/render.js'

const base = process.env.NEZHA_BASE
const token = process.env.NEZHA_TOKEN
if (!base || !token) {
  console.log('跳过：需要 NEZHA_BASE / NEZHA_TOKEN')
  process.exit(0)
}

const config = {
  baseUrl: base, apiToken: token, adminToken: '', verifySSL: true, requestTimeout: 20,
  cacheTTL: 0, enableImage: false, renderTimeout: 20000, cdnBase: '', showSiteName: true,
  maxTextLength: 1800, debug: false,
}
const ctx = {
  http: {
    async get(url, options) {
      const response = await fetch(url, { headers: options.headers })
      const text = await response.text()
      if (response.status >= 400) {
        const error = new Error('HTTP ' + response.status)
        error.response = { status: response.status }
        throw error
      }
      try { return JSON.parse(text) } catch { return text }
    },
  },
  logger: { debug() {}, warn() {}, error() {}, info() {} },
}
const api = new NezhaApi(ctx, config)

const servers = await api.fetchServers()
assert.ok(Array.isArray(servers), '服务器列表不是数组')
console.log('服务器 %d 台，第一台 %s', servers.length, servers[0]?.name)
assert.ok(servers[0] && typeof servers[0].cpuCores === 'number', '缺少 v2 字段 cpuCores')

const setting = await api.fetchSetting()
console.log('站点名 %s，TSDB %s', setting.siteName || '(空)', setting.tsdbEnabled)

const data = statusData(servers)
assert.strictEqual(data.total, servers.length)
assert.ok(detailData(servers[0]).server.cpu_cores !== undefined)

const services = await api.fetchServices()
console.log('服务监控 %d 个', services.length)
if (services.length) {
  assert.ok(serviceListData(services).services[0].up_percent >= 0)
  const detail = await api.fetchServiceDetail(services[0].id)
  console.log('  首个服务 %s，关联服务器 %d', detail.name, detail.servers.length)
}

if (servers.length) {
  const points = await api.fetchMetrics(servers[0].id, 'cpu', '1d')
  console.log('CPU 历史点 %d', points.length)
  const online = await api.fetchOnlineHistory(servers[0].id, 1)
  console.log('在线率 %s', online?.online_rate)
}
console.log('\nLIVE OK')