import { Context, Schema, Session, h } from 'koishi'
import { NezhaApi, NezhaError } from './api'
import type { Config as NezhaConfig } from './types'
import { METRIC_DISPLAY_NAMES, PERIOD_LABELS, formatBytes, formatMetricValue, percent } from './format'
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
  apiToken: Schema.string().required().role('secret').description('面板 API Token（PAT，nzp_ 开头）'),
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

const USAGE = [
  '哪吒监控面板查询。',
  '',
  '· nezha 状态 —— 服务器状态概览（CPU / 内存 / 磁盘）',
  '· nezha 概览 —— 状态 + 24h 在线率一屏看完',
  '· nezha 详情 <ID> —— 单台服务器完整信息',
  '· nezha 服务 —— 服务监控列表（可用率 / 延迟）',
  '· nezha 服务详情 <ID> —— 单个服务监控的详情',
  '· nezha 历史 <ID> <指标> [周期] —— 历史趋势，周期 1d / 7d / 30d',
  '· nezha 在线率 <ID> [天数] —— 在线率与在线时段',
  '· nezha 告警 —— 告警规则列表',
  '',
  '指标：cpu, memory, disk, load1, tcp_conn, process_count, net_in_transfer…',
  '所有查询命令都走同一个面板。',
].join('\n')

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
function friendly(error: unknown) {
  if (error instanceof NezhaError) {
    switch (error.kind) {
      case 'auth':
        return '❌ 认证失败：' + error.message + '\n💡 Token 应以 nzp_ 开头且未过期；确认没有把 JWT 当 PAT 用'
      case 'forbidden':
        return '❌ 权限不足：' + error.message + '\n💡 给 Token 补上 nezha:inventory:read / nezha:server:read / nezha:service:read，或把服务器加进白名单'
      case 'rate':
        return '❌ ' + error.message
      case 'tsdb':
        return '❌ TSDB 未启用：获取历史指标需要面板开启 TSDB（TimescaleDB）\n'
          + '💡 面板配置里设 tsdb: true，装好 TimescaleDB 后重启面板'
      case 'network':
        return '❌ ' + error.message + '\n💡 检查 baseUrl / 端口 / 防火墙；自签证书可把 verifySSL 设为 false'
      default:
        return '❌ ' + error.message
    }
  }
  return '❌ 查询失败：' + String((error as Error)?.message || error)
}

export function apply(ctx: Context, config: NezhaConfig) {
  const api = new NezhaApi(ctx, config)
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
    if (now - last < wait) return '⏳ 慢一点，' + Math.ceil((wait - (now - last)) / 1000) + ' 秒后再试'
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
    .usage(USAGE)
    .example('nezha 状态')
    .action(async ({ session }: any) => {
      await handleStatus(session!)
    })

  ctx.command('nezha.帮助', '哪吒插件帮助').alias('nezha.help')
    .action(async ({ session }: any) => {
      await deliver(session!, USAGE)
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
        if (authority < need) return await deliver(session!, '❌ 需要权限 ' + need + ' 及以上')
        const count = await pusher.sendTest(channel)
        await deliver(session!, count ? '✅ 已发送到 ' + count + ' 个频道' : '❌ 没配置 push.channels，也没给频道参数')
      } catch (error) {
        await deliver(session!, '❌ 推送测试失败：' + String((error as Error)?.message || error))
      }
    })

  ctx.command('nezha.详情 <id:number>', '单台服务器详情').alias('nezha.detail')
    .usage('nezha 详情 <服务器ID> ')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, '❌ 请指定服务器 ID，如：nezha 详情 1')
      await handleDetail(session!, id)
    })

  ctx.command('nezha.服务', '服务监控列表').alias('nezha.service')
    .action(async ({ session }: any) => {
      await handleServiceList(session!)
    })

  ctx.command('nezha.服务详情 <id:number>', '单个服务监控详情').alias('nezha.service-detail')
    .usage('nezha 服务详情 <服务ID> ')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, '❌ 请指定服务 ID，如：nezha 服务详情 1')
      await handleServiceDetail(session!, id)
    })

  ctx.command('nezha.历史 <id:number> <metric:string> [period:string]', '历史指标趋势')
    .alias('nezha.history')
    .usage('nezha 历史 <服务器ID> <指标> [周期] ')
    .action(async ({ session }: any, id?: number, metric?: string, period?: string) => {
      if (id == null || !metric) {
        return deliver(session!, '📖 用法：nezha 历史 <服务器ID> <指标> [周期]\n'
          + '指标：' + METRIC_LIST.slice(0, 8).join(', ') + ' …\n'
          + '周期：1d（默认）/ 7d / 30d\n'
          + '示例：nezha 历史 1 cpu 1d')
      }
      await handleHistory(session!, id, metric.toLowerCase(), (period || '1d').toLowerCase())
    })

  ctx.command('nezha.在线率 <id:number> [days:number]', '服务器在线率').alias('nezha.uptime')
    .usage('nezha 在线率 <服务器ID> [天数，默认 1]')
    .action(async ({ session }: any, id?: number, days?: number) => {
      if (id == null) return deliver(session!, '❌ 请指定服务器 ID，如：nezha 在线率 1 7')
      await handleOnlineRate(session!, id, days || 1)
    })

  ctx.command('nezha.告警', '告警规则列表').alias('nezha.alert')
    .action(async ({ session }: any) => {
      await handleAlerts(session!)
    })

  ctx.command('nezha.关联服务 <id:number>', '该服务器上的服务监控').alias('nezha.server-services')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, '❌ 请指定服务器 ID')
      await handleServerServices(session!, id)
    })

  ctx.command('nezha.服务服务器 <id:number>', '该服务监控覆盖的服务器').alias('nezha.service-servers')
    .action(async ({ session }: any, id?: number) => {
      if (id == null) return deliver(session!, '❌ 请指定服务 ID')
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
      return deliver(session, friendly(error))
    }
    if (!servers.length) return deliver(session, '📭 暂无服务器')
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
      return deliver(session, friendly(error))
    }
    if (!servers.length) return deliver(session, '📭 暂无服务器')
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
    if (rates.length) await deliver(session, '📈 24h 在线率：\n' + rates.join('\n'))
    else await deliver(session, '📈 24h 在线率：暂无数据')
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
      return deliver(session, friendly(error))
    }
    if (!server) return deliver(session, '❌ 未找到 ID 为 ' + id + ' 的服务器')
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
      return deliver(session, friendly(error))
    }
    if (!services.length) return deliver(session, '📭 暂无服务监控')
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
      return deliver(session, friendly(error) + '\n💡 确认服务 ID 是否正确')
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
      return deliver(session, '❌ 不支持的指标: ' + metric + '\n💡 支持：' + METRIC_LIST.slice(0, 10).join(', ') + ' …')
    }
    if (!PERIOD_LIST.includes(period)) {
      return deliver(session, '❌ 不支持的周期: ' + period + '\n💡 支持：1d, 7d, 30d')
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
      return deliver(session, friendly(error))
    }

    if (!points.length) {
      const setting = await api.fetchSetting()
      const hint = setting.tsdbEnabled
        ? '该周期内没有上报数据，换个周期试试'
        : '面板未启用 TSDB（TimescaleDB）时接口成功但点为空'
      return deliver(session, '📭 服务器 ' + serverName + ' 暂无 ' + metric + ' 历史数据\n💡 ' + hint)
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
      return deliver(session, friendly(error))
    }
    const rate = Number(data?.online_rate)
    const total = Number(data?.total_online_seconds)
    const lines = [
      '📈 ' + (data?.server_name || 'ID:' + id) + ' 在线率',
      '窗口：' + (data?.days ?? days) + ' 天（上限 ' + (data?.max_days ?? '?') + ' 天）',
      '在线率：' + (Number.isFinite(rate) ? rate.toFixed(2) + '%' : 'N/A'),
      '在线时长：' + (Number.isFinite(total) ? (total / 3600).toFixed(2) + ' 小时' : 'N/A'),
      '当前状态：' + (data?.currently_online ? '在线' : '离线'),
      '最后活跃：' + (data?.last_active || '未知'),
    ]
    const daily = Array.isArray(data?.daily) ? data.daily : []
    if (daily.length) {
      lines.push('', '按天在线：')
      for (const item of daily.slice(-14)) {
        lines.push('· ' + item.date + ' ' + (Number(item.online_seconds) / 3600).toFixed(2) + ' 小时')
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
      return deliver(session, friendly(error))
    }
    if (!rules.length) return deliver(session, '📭 暂无告警规则')
    const names = new Map<number, string>()
    try {
      for (const server of await api.fetchServers()) names.set(server.id, server.name)
    } catch {}
    const lines = ['🚨 告警规则（' + rules.length + ' 条）']
    for (const rule of rules) {
      lines.push('· #' + rule.id + ' ' + (rule.name || '未命名') + (rule.enabled === false ? '（已停用）' : ''))
      const targets = Array.isArray(rule.servers)
        ? rule.servers.map((id: any) => names.get(Number(id)) || 'ID:' + id)
        : []
      if (targets.length) lines.push('  对象：' + targets.slice(0, 6).join('、') + (targets.length > 6 ? ' 等 ' + targets.length + ' 台' : ''))
      for (const condition of Array.isArray(rule.rules) ? rule.rules : []) {
        lines.push('  条件：' + describeRule(condition))
      }
    }
    await deliver(session, lines.join('\n'))
  }

  async function handleServerServices(session: Session, id: number) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    try {
      const services = await api.fetchServerServices(id)
      if (!services.length) return deliver(session, '📭 该服务器没有关联的服务监控')
      await deliver(session, serviceListText(services))
    } catch (error) {
      return deliver(session, friendly(error))
    }
  }
  async function handleServiceServers(session: Session, id: number) {
    const busy = throttled(session)
    if (busy) return deliver(session, busy)
    try {
      const servers = await api.fetchServiceServers(id)
      if (!servers.length) return deliver(session, '📭 该服务监控没有关联服务器')
      await deliver(session, servers.map((server) => '· ' + server.name + ' (ID ' + server.id + ')').join('\n'))
    } catch (error) {
      return deliver(session, friendly(error))
    }
  }
}