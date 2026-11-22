import { Context } from 'koishi'
import { Agent as HttpsAgent } from 'node:https'
import type { Config, MetricPoint, ServerInfo, ServiceDetail, ServiceItem, ServiceServerStat } from './types'
import { percent } from './format'

export type NezhaErrorKind =
  | 'config'
  | 'auth'
  | 'network'
  | 'timeout'
  | 'server'
  | 'http'
  | 'json'
  | 'tsdb'
  | 'nodata'

export class NezhaError extends Error {
  constructor(message: string, readonly kind: NezhaErrorKind, readonly status?: number) {
    super(message)
    this.name = 'NezhaError'
  }
}

const ONLINE_THRESHOLD_SECONDS = 300
const MAX_RETRY_ATTEMPTS = 3

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
  return !['config', 'auth', 'json'].includes(error.kind)
}

export class NezhaApi {
  private cache?: { at: number; servers: ServerInfo[] }

  constructor(private ctx: Context, private config: Config) {}

  get baseUrl() {
    return (this.config.baseUrl || '').trim().replace(/\/+$/, '')
  }

  private headers(admin = false) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = admin ? this.config.adminToken : this.config.apiToken
    if (token) headers.Authorization = 'Bearer ' + token
    return headers
  }

  private requestConfig(admin = false) {
    const cfg: any = {
      headers: this.headers(admin),
      timeout: Math.max(1, this.config.requestTimeout) * 1000,
    }
    if (!this.config.verifySSL) cfg.httpsAgent = new HttpsAgent({ rejectUnauthorized: false })
    return cfg
  }

  private mapError(error: any): NezhaError {
    if (error instanceof NezhaError) return error
    const status = error?.response?.status
    if (status === 401 || status === 403) {
      return new NezhaError('认证失败，请检查 API Token 是否正确、是否过期', 'auth', status)
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

  private async request(path: string, admin = false): Promise<any> {
    if (!this.baseUrl) throw new NezhaError('未配置面板地址（baseUrl）', 'config')
    if (admin && !this.config.adminToken) {
      throw new NezhaError('管理员 Token 未配置，无法执行管理员操作', 'config')
    }
    const url = this.baseUrl + path
    this.ctx.logger.debug('GET ' + path)
    let body: any
    try {
      body = await this.ctx.http.get(url, this.requestConfig(admin))
    } catch (error) {
      throw this.mapError(error)
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
    if (typeof body.error === 'string' && body.error) {
      throw new NezhaError(body.error, 'http')
    }
    return body
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
      memUsed: safeInt(state.mem_used),
      memTotal: safeInt(host.mem_total),
      diskUsed: safeInt(state.disk_used),
      diskTotal: safeInt(host.disk_total),
      uptime: safeInt(state.uptime),
      platform: host.platform || 'N/A',
      platformVersion: host.platform_version || '',
      netInTransfer: safeInt(state.net_in_transfer),
      netOutTransfer: safeInt(state.net_out_transfer),
      lastActive,
      geoipCountry: geoip.country_code || '',
    }
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
        const body = await this.request('/api/v1/server')
        const list = Array.isArray(body) ? body : body.data
        if (!Array.isArray(list)) {
          throw new NezhaError('服务器列表格式异常，请确认 baseUrl 指向哪吒面板', 'json')
        }
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

  async fetchServices(): Promise<ServiceItem[]> {
    const body = await this.request('/api/v1/service')
    const data = body?.data ?? body
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
        let status = -1
        if (currentUp > 0 && currentDown === 0) status = 1
        else if (currentDown > 0) status = 0
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
    const body = await this.request('/api/v1/service/' + id + '/history?period=' + encodeURIComponent(period))
    const data = body?.data ?? body
    const servers: ServiceServerStat[] = []
    for (const raw of Array.isArray(data?.servers) ? data.servers : []) {
      const stats = raw?.stats || {}
      servers.push({
        serverName: raw?.server_name || '未知服务器',
        upPercent: safeFloat(stats.up_percent),
        avgDelay: safeFloat(stats.avg_delay),
        totalUp: safeFloat(stats.total_up),
        totalDown: safeFloat(stats.total_down),
      })
    }
    return { name: data?.service_name || '未命名', servers }
  }

  async fetchMetrics(id: number, metric: string, period = '1d'): Promise<MetricPoint[]> {
    const path = '/api/v1/server/' + id + '/metrics?metric=' + encodeURIComponent(metric)
      + '&period=' + encodeURIComponent(period)
    let body: any
    try {
      body = await this.request(path)
    } catch (error) {
      const message = String((error as Error)?.message || '')
      if (/tsdb|timescale/i.test(message)) {
        throw new NezhaError(message, 'tsdb')
      }
      throw error
    }
    const data = body?.data ?? body
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
