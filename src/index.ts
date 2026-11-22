import { Context, Schema, Session, h } from 'koishi'
import { NezhaApi, NezhaError } from './api'
import type { Config as NezhaConfig } from './types'
import { METRIC_DISPLAY_NAMES, PERIOD_LABELS } from './format'
import { t, type Locale } from './i18n'
import { Pusher } from './push'
import {
  analyzeHistory,
  detailData,
  detailText,
  historyData,
  historyText,
  renderCard,
  serviceDetailData,
  serviceDetailText,
  serviceListData,
  serviceListText,
  splitText,
  statusData,
  statusText,
} from './render'
import { ServerStream } from './watch'

export const name = 'nezha'
export const inject = { required: ['http'], optional: ['puppeteer'] }
export const Config: Schema<NezhaConfig> = Schema.object({
  baseUrl: Schema.string().required().description('面板地址，如 https://nezha.example.com:8008'),
  apiToken: Schema.string().role('secret').description('面板 API Token（nzp_ 开头）；留空即游客模式，面板开 force_auth 时必须填'),
  locale: Schema.union([
    Schema.const('zh-CN').description('中文'),
    Schema.const('en-US').description('English'),
  ] as const).default('zh-CN').description('文字输出语言；卡片模板固定中文'),
  verifySSL: Schema.boolean().default(true).description('是否校验 SSL 证书；面板用自签证书且连接报错时关掉'),
  requestTimeout: Schema.number().default(30).min(1).description('API 请求超时（秒）'),
  cacheTTL: Schema.number().default(30).min(0).description('服务器列表缓存有效期（秒），0 表示每次实时请求'),
  watch: Schema.object({
    enabled: Schema.boolean().default(false).description('订阅面板实时状态流（/api/v1/ws/server）刷新缓存'),
    maxBackoff: Schema.number().default(30).min(2).description('断线重连退避上限（秒）'),
  }).description('实时状态流'),
  push: Schema.object({
    enabled: Schema.boolean().default(false).description('定时把状态概览和告警推到频道'),
    interval: Schema.number().default(30).min(1).description('推送间隔（分钟）'),
    channels: Schema.array(Schema.string()).default([]).description('目标频道，格式 platform:channelId'),
    thresholdCpu: Schema.number().default(90).description('CPU 告警阈值（%），0 关闭'),
    thresholdMem: Schema.number().default(90).description('内存告警阈值（%），0 关闭'),
    thresholdDisk: Schema.number().default(90).description('磁盘告警阈值（%），0 关闭'),
    offline: Schema.boolean().default(true).description('服务器离线时告警'),
    cooldown: Schema.number().default(30).min(0).description('同一告警重复推送的最小间隔（分钟）'),
  }).description('定时推送与告警'),
  pushTestAuthority: Schema.number().default(3).min(0).description('nezha 推送测试 需要的最低权限，0 = 所有人'),
  userCooldown: Schema.number().default(3).min(0).description('同一用户连续查询的最小间隔（秒），0 关闭'),
  enableImage: Schema.boolean().default(true).description('把结果渲染成卡片图（需要 koishi-plugin-puppeteer）'),
  renderTimeout: Schema.number().default(30000).min(1000).description('出图超时（毫秒）'),
  cdnBase: Schema.string().default('https://fastly.jsdelivr.net').description('模板里 flag-icons / font-logos 的 CDN 前缀，可换成自己的镜像'),
  showSiteName: Schema.boolean().default(true).description('卡片标题用面板设置的站点名，关掉则显示「哪吒监控」'),
  maxTextLength: Schema.number().default(1800).min(50).description('单条文字消息最大字符数'),
  debug: Schema.boolean().default(false).description('输出调试日志'),
})

const RULE_TYPES: Record<string, string> = {
  cpu: 'CPU', gpu: 'GPU', gpu_max: 'GPU 峰值', memory: '内存', swap: 'Swap', disk: '磁盘',
  net_in_speed: '入站速率', net_out_speed: '出站速率', net_all_speed: '总速率',
  transfer_in: '入站流量', transfer_out: '出站流量', transfer_all: '总流量', offline: '离线',
}

function describeRule(rule: any) {
  if (!rule || typeof rule !== 'object') return String(rule)
  const label = RULE_TYPES[String(rule.type)] || String(rule.type || '未知指标')
  const parts = [label]
  if (rule.min) parts.push('≥ ' + rule.min)
  if (rule.max) parts.push('≤ ' + rule.max)
  if (rule.duration) parts.push('持续 ' + rule.duration + 's')
  if (rule.cycle_interval) parts.push('周期 ' + rule.cycle_interval + 's')
  return parts.join(' ')
}

const METRIC_LIST = Object.keys(METRIC_DISPLAY_NAMES)
const PERIOD_LIST = Object.keys(PERIOD_LABELS)
function friendly(error: unknown, L: (key: any, ...args: Array<string | number>) => string, hasToken: boolean) {
  if (error instanceof NezhaError) {
    switch (error.kind) {
      case 'auth':
        return hasToken ? L('authFail', error.message) : L('authGuest')
      case 'forbidden':
        return L('forbidden', error.message)
      case 'rate':
        return '❌ ' + error.message
      case 'tsdb':
        return L('tsdbFail')
      case 'network':
        return L('networkFail', error.message)
      default:
        return '❌ ' + error.message
    }
  }
  return L('genericFail', String((error as Error)?.message || error))
}

export function apply(ctx: Context, config: NezhaConfig) {
  const api = new NezhaApi(ctx, config)
  const locale: Locale = (config.locale as Locale) || 'zh-CN'
  const L = (key: Parameters<typeof t>[1], ...args: Array<string | number>) => t(locale, key, ...args)
  const pusher = new Pusher(ctx, config, api)
  const streams: ServerStream[] = []

  ctx.on('ready', () => {
    ctx.logger.info('nezha 已加载 → %s', config.baseUrl || '(未配置)')
    if (config.watch?.enabled) {
      const stream = new ServerStream(ctx, api, config)
      stream.start()
      streams.push(stream)
    }
    pusher.start()
  })
  ctx.on('dispose', () => {
    pusher.stop()
    for (const stream of streams) stream.stop()
  })
  const lastCall = new Map<string, number>()

  function throttled(session: Session) {
    const wait = Math.max(0, config.userCooldown || 0) * 1000
    if (!wait) return ''
    const now = Date.now()
    const key = String(session.userId || (session.user as any)?.id || '')
    const last = lastCall.get(key) || 0
    if (now - last < wait) return L('slow', Math.ceil((wait - (now - last)) / 1000))
    lastCall.set(key, now)
    return ''
  }

  function logError(error: unknown) {
    const expected = error instanceof NezhaError && ['auth', 'forbidden', 'rate', 'timeout', 'tsdb'].includes(error.kind)
    const message = String((error as Error)?.message || error)
    if (expected) ctx.logger.warn('nezha: %s', message)
    else ctx.logger.error('nezha: %s', message)
  }

  let rendering = 0
  const renderQueue: Array<() => void> = []

  /** 同时最多渲染 2 张，多的排队，别把浏览器拖死 */
  async function renderSlot<T>(run: () => Promise<T>): Promise<T> {
    while (rendering >= 2) await new Promise<void>((resolve) => renderQueue.push(resolve))
    rendering++
    try {
      return await run()
    } finally {
      rendering--
      renderQueue.shift()?.()
    }
  }

  async function deliver(session: Session, payload: string | h) {
    if (typeof payload === 'string') {
      for (const part of splitText(payload, config.maxTextLength)) await session.send(part)
    } else {
      await session.send(payload)
    }
  }

  /** 能出图就出图，失败或没装 puppeteer 就降级文字 */
  async function card(template: string, data: Record<string, any>, text: string) {
    if (config.enableImage && (ctx as any).puppeteer) {
      try {
        const buffer = await renderSlot(() => renderCard(ctx, config, template, data))
        return h.image(buffer, 'image/png')
      } catch (error) {
        ctx.logger.warn('出图失败，降级为文字: %s', (error as Error)?.message)
      }
    }
    return text
  }

  ctx.command('nezha', '哪吒监控面板查询')
    .usage(L('usage'))
    .example('nezha 状态')
    .action(async ({ session }: any) => {
      await handleStatus(session!)
    })

  ctx.command('nezha.帮助', '哪吒插件帮助').alias('nezha.help')
    .action(async ({ session }: any) => {
      await deliver(session!, L('usage'))
    })


  ctx.command('nezha.状态', '服务器状态概览').alias('nezha.status')
    .action(async ({ session }: any) => {
      await handleStatus(session!)
    })

  ctx.command('nezha.概览', '状态与 24h 在线率一屏看完').alias('nezha.overview')
    .action(async ({ session }: any) => {
      await handleOverview(session!)
    })

  ctx.command('nezha.推送测试 [channel:string]', '往推送频道发一条测试消息').alias('nezha.push-test')
    .usage('nezha 推送测试 [platform:channelId]')
    .action(async ({ session }, channel?: string) => {
      try {
        const need = Math.max(0, config.pushTestAuthority || 0)
        const authority = Number((session as any)?.authority ?? (session!.user as any)?.authority ?? 0)
        if (authority < need) return await deliver(session!, L('needAuthority', need))
        const count = await pusher.sendTest(channel)
        await deliver(session!, count ? L('pushSent', count) : L('pushNoChannel'))
      } catch (error) {
        await deliver(session!, L('pushTestFail', String((error as Error)?.message || error)))
      }
    })

  ctx.command('nezha.详情 <id:number>', '单台服务器详情').alias('nezha.detail')
    .usage('nezha 详情 <服务器ID> ')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, L('needServerId'))
      await handleDetail(session!, id)
    })

  ctx.command('nezha.服务', '服务监控列表').alias('nezha.service')
    .action(async ({ session }: any) => {
      await handleServiceList(session!)
    })

  ctx.command('nezha.服务详情 <id:number>', '单个服务监控详情').alias('nezha.service-detail')
    .usage('nezha 服务详情 <服务ID> ')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, L('needServiceId'))
      await handleServiceDetail(session!, id)
    })

  ctx.command('nezha.历史 <id:number> <metric:string> [period:string]', '历史指标趋势')
    .alias('nezha.history')
    .usage('nezha 历史 <服务器ID> <指标> [周期] ')
    .action(async ({ session }: any, id?: number, metric?: string, period?: string) => {
      if (id == null || !metric) {
        return deliver(session!, L('historyUsage', METRIC_LIST.slice(0, 8).join(', ')))
      }
      await handleHistory(session!, id, metric.toLowerCase(), (period || '1d').toLowerCase())
    })

  ctx.command('nezha.在线率 <id:number> [days:number]', '服务器在线率').alias('nezha.uptime')
    .usage('nezha 在线率 <服务器ID> [天数，默认 1]')
    .action(async ({ session }: any, id?: number, days?: number) => {
      if (id == null) return deliver(session!, L('needServerIdRate'))
      await handleOnlineRate(session!, id, days || 1)
    })

  ctx.command('nezha.告警', '告警规则列表').alias('nezha.alert')
    .action(async ({ session }: any) => {
      await handleAlerts(session!)
    })

  ctx.command('nezha.关联服务 <id:number>', '该服务器上的服务监控').alias('nezha.server-services')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, L('needServerIdShort'))
      await handleServerServices(session!, id)
    })

  ctx.command('nezha.服务服务器 <id:number>', '该服务监控覆盖的服务器').alias('nezha.service-servers')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, L('needServiceIdShort'))
      await handleServiceServers(session!, id)
    })
  async function handleStatus(session: Session) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    let servers
    try {
      servers = await api.fetchServers()
    } catch (error) {
      logError(error)
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
    if (!servers.length) return deliver(session, L('emptyServers'))
    const name = await api.fetchSiteName()
    const payload = await card('status', { ...statusData(servers), site_name: name }, statusText(servers))
    await deliver(session, payload)
  }

  async function handleOverview(session: Session) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    let servers
    try {
      servers = await api.fetchServers()
    } catch (error) {
      logError(error)
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
    if (!servers.length) return deliver(session, L('emptyServers'))
    const name = await api.fetchSiteName()
    await deliver(session, await card('status', { ...statusData(servers), site_name: name }, statusText(servers)))

    const rates: string[] = []
    for (const server of servers.slice(0, 5)) {
      try {
        const data = await api.fetchOnlineHistory(server.id, 1)
        const rate = Number(data?.online_rate)
        if (Number.isFinite(rate)) rates.push('· ' + server.name + ' ' + rate.toFixed(1) + '%')
      } catch {}
    }
    if (rates.length) await deliver(session, L('overviewRates') + '\n' + rates.join('\n'))
    else await deliver(session, L('overviewNoRate'))
  }

  async function handleDetail(session: Session, id: number) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    let server
    try {
      const servers = await api.fetchServers()
      server = servers.find((item) => item.id === id)
    } catch (error) {
      logError(error)
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
    if (!server) return deliver(session, L('notFoundServer', id))
    const name = await api.fetchSiteName()
    const payload = await card('server_detail', { ...detailData(server), site_name: name }, detailText(server))
    await deliver(session, payload)
  }

  async function handleServiceList(session: Session) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    let services
    try {
      services = await api.fetchServices()
    } catch (error) {
      logError(error)
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
    if (!services.length) return deliver(session, L('emptyServices'))
    const name = await api.fetchSiteName()
    const payload = await card('service_list', { ...serviceListData(services), site_name: name }, serviceListText(services))
    await deliver(session, payload)
  }

  async function handleServiceDetail(session: Session, id: number) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    let detail
    try {
      detail = await api.fetchServiceDetail(id)
    } catch (error) {
      logError(error)
      return deliver(session, friendly(error, L, Boolean(config.apiToken)) + '\n💡 确认服务 ID 是否正确')
    }
    const name = await api.fetchSiteName()
    const payload = await card('service_detail', { ...serviceDetailData(detail), site_name: name }, serviceDetailText(detail))
    await deliver(session, payload)

    if (detail.points.length > 1) {
      const options = { serverName: detail.name, metric: 'delay', period: '1d' }
      const analysis = analyzeHistory(detail.points, options)
      await deliver(session, await card('history', { ...historyData(analysis, options), site_name: name }, historyText(analysis, options)))
    }
  }

  async function handleHistory(session: Session, id: number, metric: string, period: string) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    if (!METRIC_LIST.includes(metric)) {
      return deliver(session, L('badMetric', metric, METRIC_LIST.slice(0, 10).join(', ')))
    }
    if (!PERIOD_LIST.includes(period)) {
      return deliver(session, L('badPeriod', period))
    }

    let serverName = 'ID:' + id
    let diskTotal: number | undefined
    let points
    try {
      const servers = await api.fetchServers()
      const server = servers.find((item) => item.id === id)
      if (server) {
        serverName = server.name
        diskTotal = server.diskTotal
      }
      points = await api.fetchMetrics(id, metric, period)
    } catch (error) {
      logError(error)
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }

    if (!points.length) {
      const setting = await api.fetchSetting()
      const hint = setting.tsdbEnabled
        ? L('hintTsdbOn')
        : L('hintTsdbOff')
      return deliver(session, L('emptyHistory', serverName, metric, hint))
    }

    const options = { serverName, metric, period, diskTotal }
    const analysis = analyzeHistory(points, options)
    const name = await api.fetchSiteName()
    const payload = await card('history', { ...historyData(analysis, options), site_name: name }, historyText(analysis, options))
    await deliver(session, payload)
  }

  async function handleOnlineRate(session: Session, id: number, days: number) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    let data
    try {
      data = await api.fetchOnlineHistory(id, days)
    } catch (error) {
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
    const rate = Number(data?.online_rate)
    const total = Number(data?.total_online_seconds)
    const lines = [
      L('onlineRateTitle', data?.server_name || 'ID:' + id),
      L('onlineRateWindow', data?.days ?? days, data?.max_days ?? '?'),
      L('onlineRateValue', Number.isFinite(rate) ? rate.toFixed(2) + '%' : 'N/A'),
      L('onlineRateTotal', Number.isFinite(total) ? (total / 3600).toFixed(2) : 'N/A'),
      L('onlineRateNow', data?.currently_online ? L('onlineOn') : L('onlineOff')),
      L('onlineRateLast', data?.last_active || 'N/A'),
    ]
    const daily = Array.isArray(data?.daily) ? data.daily : []
    if (daily.length) {
      lines.push('', L('onlineDaily'))
      for (const item of daily.slice(-14)) {
        lines.push('· ' + item.date + ' ' + L('hours', (Number(item.online_seconds) / 3600).toFixed(2)))
      }
    }
    await deliver(session, lines.join('\n'))
  }

  async function handleAlerts(session: Session) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    let rules
    try {
      rules = await api.fetchAlertRules()
    } catch (error) {
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
    if (!rules.length) return deliver(session, '📭 暂无告警规则')
    const names = new Map<number, string>()
    try {
      for (const server of await api.fetchServers()) names.set(server.id, server.name)
    } catch {}
    const lines = [L('rulesTitle', rules.length)]
    for (const rule of rules) {
      lines.push(L('ruleLine', rule.id, rule.name || '未命名', rule.enabled === false ? L('ruleDisabled') : ''))
      const targets = Array.isArray(rule.servers)
        ? rule.servers.map((id: any) => names.get(Number(id)) || 'ID:' + id)
        : []
      if (targets.length) {
        lines.push(L('ruleTargets', targets.slice(0, 6).join('、') + (targets.length > 6 ? L('ruleMore', targets.length) : '')))
      }
      for (const condition of Array.isArray(rule.rules) ? rule.rules : []) {
        lines.push(L('ruleCondition', describeRule(condition)))
      }
    }
    await deliver(session, lines.join('\n'))
  }

  async function handleServerServices(session: Session, id: number) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    try {
      const services = await api.fetchServerServices(id)
      if (!services.length) return deliver(session, L('emptyServerServices'))
      await deliver(session, serviceListText(services))
    } catch (error) {
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
  }
  async function handleServiceServers(session: Session, id: number) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    try {
      const servers = await api.fetchServiceServers(id)
      if (!servers.length) return deliver(session, L('emptyServiceServers'))
      await deliver(session, servers.map((server) => '· ' + server.name + ' (ID ' + server.id + ')').join('\n'))
    } catch (error) {
      return deliver(session, friendly(error, L, Boolean(config.apiToken)))
    }
  }
}