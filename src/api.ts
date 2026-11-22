import { Context } from 'koishi'
import { Agent as HttpsAgent } from 'node:https'
import type {
  Config,
  MetricPoint,
  NezhaErrorKind,
  ServerInfo,
  ServiceDetail,
  ServiceItem,
  ServiceServerStat,
} from './types'
import { percent } from './format'

export class NezhaError extends Error {
  constructor(message: string, readonly kind: NezhaErrorKind, readonly status?: number) {
    super(message)
    this.name = 'NezhaError'
  }
}

const ONLINE_THRESHOLD_SECONDS = 300
const MAX_RETRY_ATTEMPTS = 3
const MAX_PAGES = 20
const SITE_NAME_TTL = 10 * 60 * 1000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function safeFloat(value: any, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function safeInt(value: any, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function isRetryable(error: unknown) {
  if (!(error instanceof NezhaError)) return true
  return !['config', 'auth', 'forbidden', 'json'].includes(error.kind)
}

/**
 * 面板 v2 的返回是 { success, data } 信封，失败是 { success:false, error } 或纯 { error }。
 * 这里统一拆出 data，并在 success=false 时抛错，避免上层各写一份判断。
 */
function unwrap(body: any): any {
  if (body && typeof body === 'object' && body.success === false) {
    const message = typeof body.error === 'string' && body.error ? body.error : '面板返回失败'
    throw new NezhaError(message, /tsdb|timescale/i.test(message) ? 'tsdb' : 'http')
  }
  if (body && typeof body === 'object' && 'data' in body && 'success' in body) return body.data
  return body
}

export class NezhaApi {
  private cache?: { at: number; servers: ServerInfo[] }
  private setting?: { at: number; value: { siteName: string; tsdbEnabled: boolean } }

  constructor(private ctx: Context, private config: Config) {}

  get baseUrl() {
    return (this.config.baseUrl || '').trim().replace(/\/+$/, '')
  }

  private headers() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiToken) headers.Authorization = 'Bearer ' + this.config.apiToken
    return headers
  }

  private requestConfig() {
    const cfg: any = {
      headers: this.headers(),
      timeout: Math.max(1, this.config.requestTimeout) * 1000,
    }
    if (!this.config.verifySSL) cfg.httpsAgent = new HttpsAgent({ rejectUnauthorized: false })
    return cfg
  }

  private mapError(error: any): NezhaError {
    if (error instanceof NezhaError) return error
    const status = error?.response?.status
    if (status === 401) {
      return new NezhaError('认证失败：API Token 无效、已过期，或 Authorization 头格式不对', 'auth', status)
    }
    if (status === 403) {
      return new NezhaError('权限不足：Token 缺少所需的 scope，或该服务器不在白名单内', 'forbidden', status)
    }
    if (status === 429) {
      return new NezhaError('请求过于频繁，面板做了限流，稍后再试或调大 cacheTTL', 'rate', status)
    }
    if (status && status >= 500) {
      return new NezhaError('面板返回服务器错误: ' + status, 'server', status)
    }
    if (status) {
      return new NezhaError('请求失败: HTTP ' + status, 'http', status)
    }
    const code = String(error?.code || error?.cause?.code || '')
    const message = String(error?.message || error) + ' ' + String(error?.cause?.message || '')
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(message)) {
      return new NezhaError('请求超时，可调大 requestTimeout 或检查网络', 'timeout')
    }
    if (/certificate|self.signed|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(message + ' ' + code)) {
      return new NezhaError('TLS 证书校验失败，自签证书可把 verifySSL 设为 false', 'network')
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new NezhaError('无法解析面板域名，请检查 baseUrl', 'network')
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return new NezhaError('无法连接到面板: ' + this.baseUrl, 'network')
    }
    if (/fetch failed|network|socket hang up|connect/i.test(message)) {
      return new NezhaError('无法连接到面板: ' + this.baseUrl, 'network')
    }
    return new NezhaError('请求处理失败: ' + message.trim(), 'network')
  }

  private async request(path: string, retryOn429 = true): Promise<any> {
    if (!this.baseUrl) throw new NezhaError('未配置面板地址（baseUrl）', 'config')
    if (!this.config.apiToken) throw new NezhaError('未配置 API Token', 'config')
    const url = this.baseUrl + path
    this.ctx.logger.debug('GET ' + path)
    let body: any
    try {
      body = await this.ctx.http.get(url, this.requestConfig())
    } catch (error) {
      const mapped = this.mapError(error)
      if (mapped.kind === 'rate' && retryOn429) {
        await sleep(1500)
        return this.request(path, false)
      }
      throw mapped
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        throw new NezhaError('响应格式错误，请检查面板地址是否正确', 'json')
      }
    }
    if (body === null || typeof body !== 'object') {
      throw new NezhaError('响应格式错误，请检查面板地址是否正确', 'json')
    }
    // 部分路由的 404 是纯 { error } 文本
    if (typeof body.error === 'string' && body.error && !('data' in body) && !('success' in body)) {
      throw new NezhaError(body.error, 'http')
    }
    return unwrap(body)
  }

  /** 站点名与 TSDB 开关，10 分钟缓存；拿不到就回退 */
  async fetchSetting(): Promise<{ siteName: string; tsdbEnabled: boolean }> {
    const now = Date.now()
    if (this.setting && now - this.setting.at < SITE_NAME_TTL) return this.setting.value
    const fallback = { siteName: '', tsdbEnabled: false }
    try {
      const data = await this.request('/api/v1/setting')
      const value = {
        siteName: String(data?.config?.site_name || data?.site_name || '').trim(),
        tsdbEnabled: Boolean(data?.tsdb_enabled ?? data?.config?.tsdb_enabled),
      }
      this.setting = { at: now, value }
      return value
    } catch {
      this.setting = { at: now, value: fallback }
      return fallback
    }
  }

  /** 卡片标题用的站点名；showSiteName 关掉时返回空 */
  async fetchSiteName(): Promise<string> {
    if (!this.config.showSiteName) return ''
    return (await this.fetchSetting()).siteName
  }

  async fetchAlertRules(): Promise<any[]> {
    try {
      const data = await this.request('/api/v1/alert-rule')
      const list = Array.isArray(data) ? data : data?.value ?? data?.rules ?? []
      return Array.isArray(list) ? list : []
    } catch (error) {
      // 只有路由不存在才当空列表；403 要透出缺 scope
      if (error instanceof NezhaError && error.status === 404) return []
      throw error
    }
  }

  async fetchOnlineHistory(id: number, days = 1): Promise<any> {
    return this.request('/api/v1/server/' + id + '/online-history?days=' + Math.max(1, Math.trunc(days)))
  }

  async fetchServerServices(id: number): Promise<ServiceItem[]> {
    return this.parseServiceList(await this.request('/api/v1/server/' + id + '/service'))
  }

  /** 面板没有 /service/{id}/server 路由，从 history 的 servers 里取关联服务器 */
  async fetchServiceServers(id: number): Promise<Array<{ id: number; name: string }>> {
    const data = await this.request('/api/v1/service/' + id + '/history?period=1d')
    const list = Array.isArray(data?.servers) ? data.servers : []
    return list.map((raw: any) => ({
      id: safeInt(raw?.server_id ?? raw?.id),
      name: raw?.server_name || raw?.name || '未知服务器',
    }))
  }

  parseServer(raw: any): ServerInfo {
    const state = raw?.state || {}
    const host = raw?.host || {}
    const geoip = raw?.geoip || {}
    const lastActive = raw?.last_active || ''
    let online = false
    if (lastActive) {
      const ts = Date.parse(lastActive)
      if (!Number.isNaN(ts)) online = Date.now() - ts < ONLINE_THRESHOLD_SECONDS * 1000
    }
    return {
      id: safeInt(raw?.id),
      name: raw?.name || '未命名',
      online,
      cpu: safeFloat(state.cpu),
      cpuCores: Array.isArray(host.cpu) ? host.cpu.length : safeInt(host.cpu),
      swapUsed: safeInt(state.swap_used),
      swapTotal: safeInt(host.swap_total),
      load1: safeFloat(state.load_1),
      load5: safeFloat(state.load_5),
      load15: safeFloat(state.load_15),
      tcpConn: safeInt(state.tcp_conn_count),
      udpConn: safeInt(state.udp_conn_count),
      processCount: safeInt(state.process_count),
      memUsed: safeInt(state.mem_used),
      memTotal: safeInt(host.mem_total),
      diskUsed: safeInt(state.disk_used),
      diskTotal: safeInt(host.disk_total),
      uptime: safeInt(state.uptime),
      platform: host.platform || 'N/A',
      platformVersion: host.platform_version || '',
      arch: host.arch || '',
      bootTime: safeInt(host.boot_time),
      netInTransfer: safeInt(state.net_in_transfer),
      netOutTransfer: safeInt(state.net_out_transfer),
      netInSpeed: safeInt(state.net_in_speed),
      netOutSpeed: safeInt(state.net_out_speed),
      lastActive,
      geoipCountry: geoip.country_code || '',
    }
  }

  /** 兼容两种列表形态：data 直接是数组，或分页的 { value, pagination } */
  private async fetchServerPages(): Promise<any[]> {
    const first = await this.request('/api/v1/server')
    if (Array.isArray(first)) return first
    if (Array.isArray(first?.value)) {
      const list = first.value.slice()
      const total = safeInt(first?.pagination?.total, list.length)
      for (let page = 2; page <= MAX_PAGES && list.length < total; page++) {
        const next = await this.request('/api/v1/server?page=' + page)
        const chunk = Array.isArray(next?.value) ? next.value : []
        if (!chunk.length) break
        list.push(...chunk)
      }
      return list
    }
    if (Array.isArray(first?.servers)) return first.servers
    throw new NezhaError('服务器列表格式异常，请确认 baseUrl 指向哪吒监控面板', 'json')
  }

  async fetchServers(force = false): Promise<ServerInfo[]> {
    const now = Date.now()
    const ttl = Math.max(0, this.config.cacheTTL) * 1000
    if (!force && this.cache && now - this.cache.at < ttl) {
      this.ctx.logger.debug('命中服务器列表缓存')
      return this.cache.servers
    }
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const list = await this.fetchServerPages()
        const servers = list.map((raw: any) => this.parseServer(raw))
        this.cache = { at: Date.now(), servers }
        return servers
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt === MAX_RETRY_ATTEMPTS - 1) break
        const wait = 1000 * Math.pow(2, attempt) + Math.random() * 500
        this.ctx.logger.debug('获取服务器列表失败，' + Math.round(wait) + 'ms 后重试')
        await sleep(wait)
      }
    }
    throw lastError instanceof NezhaError ? lastError : new NezhaError('获取服务器列表失败', 'network')
  }

  /** 实时流推来的快照直接灌进缓存 */
  ingestServers(list: any[]) {
    this.cache = { at: Date.now(), servers: list.map((raw) => this.parseServer(raw)) }
  }

  async fetchServices(): Promise<ServiceItem[]> {
    return this.parseServiceList(await this.request('/api/v1/service'))
  }

  private parseServiceList(data: any): ServiceItem[] {
    const result: ServiceItem[] = []

    const pushFromDict = (dict: Record<string, any>) => {
      for (const [id, svc] of Object.entries(dict || {})) {
        if (!svc || typeof svc !== 'object') continue
        const up: number[] = Array.isArray((svc as any).up) ? (svc as any).up : []
        const down: number[] = Array.isArray((svc as any).down) ? (svc as any).down : []
        const delay: number[] = Array.isArray((svc as any).delay) ? (svc as any).delay : []
        const totalUp = up.reduce((a, b) => a + safeFloat(b), 0)
        const totalDown = down.reduce((a, b) => a + safeFloat(b), 0)
        const checks = totalUp + totalDown
        const currentUp = safeInt((svc as any).current_up)
        const currentDown = safeInt((svc as any).current_down)
        // v2 的 current_* 是最近若干次探测的计数，按下线占比判定状态
        let status = -1
        if (currentUp + currentDown > 0) status = currentDown >= currentUp ? 0 : 1
        result.push({
          id: safeInt(id),
          name: (svc as any).service_name || '未命名',
          status,
          avgDelay: delay.length ? delay.reduce((a, b) => a + safeFloat(b), 0) / delay.length : 0,
          upPercent: checks > 0 ? (totalUp / checks) * 100 : 0,
          currentUp,
          currentDown,
          totalUp,
          totalDown,
        })
      }
    }

    if (data && typeof data === 'object' && !Array.isArray(data) && (data as any).services) {
      pushFromDict((data as any).services)
    } else if (Array.isArray(data)) {
      for (const svc of data) {
        if (!svc || typeof svc !== 'object') continue
        const up = safeFloat((svc as any).total_up)
        const down = safeFloat((svc as any).total_down)
        const checks = up + down
        result.push({
          id: safeInt((svc as any).id),
          name: (svc as any).name || (svc as any).service_name || '未命名',
          status: safeInt((svc as any).status, -1),
          avgDelay: safeFloat((svc as any).avg_delay),
          upPercent: checks > 0 ? (up / checks) * 100 : safeFloat((svc as any).up_percent),
          currentUp: safeInt((svc as any).current_up),
          currentDown: safeInt((svc as any).current_down),
          totalUp: up,
          totalDown: down,
        })
      }
    } else if (data && typeof data === 'object') {
      pushFromDict(data as Record<string, any>)
    }
    return result
  }

  async fetchServiceDetail(id: number, period = '1d'): Promise<ServiceDetail> {
    const data = await this.request('/api/v1/service/' + id + '/history?period=' + encodeURIComponent(period))
    const servers: ServiceServerStat[] = []
    const points: MetricPoint[] = []
    for (const raw of Array.isArray(data?.servers) ? data.servers : []) {
      const stats = raw?.stats || {}
      servers.push({
        serverName: raw?.server_name || '未知服务器',
        upPercent: safeFloat(stats.up_percent),
        avgDelay: safeFloat(stats.avg_delay),
        totalUp: safeFloat(stats.total_up),
        totalDown: safeFloat(stats.total_down),
      })
      // 多台服务器时只画第一台的曲线，避免混在一起
      if (!points.length) {
        for (const point of Array.isArray(stats.data_points) ? stats.data_points : []) {
          const delay = Number(point?.delay)
          if (Number.isFinite(delay) && delay > 0) points.push({ ts: safeInt(point?.ts), value: delay })
        }
      }
    }
    return { name: data?.service_name || '未命名', servers, points }
  }

  /** 历史指标；点为空时返回 reason='empty'，由上层提示 TSDB/周期 */
  async fetchMetrics(id: number, metric: string, period = '1d'): Promise<MetricPoint[]> {
    const path = '/api/v1/server/' + id + '/metrics?metric=' + encodeURIComponent(metric)
      + '&period=' + encodeURIComponent(period)
    const data = await this.request(path)
    const points: MetricPoint[] = []
    for (const raw of Array.isArray(data?.data_points) ? data.data_points : []) {
      const value = Number(raw?.value)
      if (!Number.isFinite(value)) continue
      points.push({ ts: safeInt(raw?.ts), value })
    }
    return points
  }
}

export { percent }