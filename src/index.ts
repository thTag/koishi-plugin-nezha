import { Context, Schema, Session, h } from 'koishi'
import { NezhaApi, NezhaError } from './api'
import type { Config as NezhaConfig } from './types'
import { METRIC_DISPLAY_NAMES, PERIOD_LABELS } from './format'
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

export const name = 'nezha'
export const inject = { required: ['http'], optional: ['puppeteer'] }

export const Config: Schema<NezhaConfig> = Schema.object({
  baseUrl: Schema.string().required().description('哪吒面板地址，如 https://nezha.example.com:8008'),
  apiToken: Schema.string().required().role('secret').description('面板 API Token（PAT），在面板后台生成'),
  adminToken: Schema.string().role('secret').description('管理员 Token（预留，暂未使用）'),
  verifySSL: Schema.boolean().default(true).description('是否校验 SSL 证书；面板用自签证书且连接报错时关掉'),
  requestTimeout: Schema.number().default(30).min(1).description('API 请求超时（秒）'),
  cacheTTL: Schema.number().default(30).min(0).description('服务器列表缓存有效期（秒），0 表示每次实时请求'),
  enableImage: Schema.boolean().default(true).description('把结果渲染成卡片图（需要 koishi-plugin-puppeteer）'),
  renderTimeout: Schema.number().default(30000).min(1000).description('出图超时（毫秒）'),
  cdnBase: Schema.string().default('https://fastly.jsdelivr.net').description('模板里 flag-icons / font-logos 的 CDN 前缀，可换成自己的镜像'),
  maxTextLength: Schema.number().default(1800).min(50).description('单条文字消息最大字符数'),
  debug: Schema.boolean().default(false).description('输出调试日志'),
})

const USAGE = [
  '哪吒监控面板查询。',
  '',
  '· nezha 状态 —— 服务器状态概览（CPU / 内存 / 磁盘）',
  '· nezha 详情 <ID> —— 单台服务器完整信息',
  '· nezha 服务 —— 服务监控列表（可用率 / 延迟）',
  '· nezha 服务详情 <ID> —— 单个服务监控的详情',
  '· nezha 历史 <ID> <指标> [周期] —— 历史趋势，周期 1d / 7d / 30d',
  '',
  '指标：cpu, memory, disk, load1, tcp_conn, process_count, net_in_transfer…',
  '英文别名：status / detail / service / service-detail / history',
].join('\n')

const METRIC_LIST = Object.keys(METRIC_DISPLAY_NAMES)
const PERIOD_LIST = Object.keys(PERIOD_LABELS)

function friendly(error: unknown) {
  if (error instanceof NezhaError) {
    switch (error.kind) {
      case 'auth':
        return '❌ 认证失败：' + error.message + '\n💡 确认 Token 有效，且有 nezha:server:read / nezha:service:read 权限'
      case 'tsdb':
        return '❌ TSDB 未启用：获取历史指标需要面板开启 TSDB（TimescaleDB）\n'
          + '💡 面板配置里设 tsdb: true，装好 TimescaleDB 后重启面板'
      case 'network':
        return '❌ ' + error.message + '\n💡 检查 baseUrl / 端口 / 防火墙；自签证书可把 verifySSL 设为 false'
      case 'timeout':
        return '❌ ' + error.message
      default:
        return '❌ ' + error.message
    }
  }
  return '❌ 查询失败：' + String((error as Error)?.message || error)
}

export function apply(ctx: Context, config: NezhaConfig) {
  const api = new NezhaApi(ctx, config)

  ctx.on('ready', () => {
    ctx.logger.info('nezha 已加载 → %s', config.baseUrl || '(未配置)')
  })

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
        const buffer = await renderCard(ctx, config, template, data)
        return h.image(buffer, 'image/png')
      } catch (error) {
        ctx.logger.warn('出图失败，降级为文字: %s', (error as Error)?.message)
      }
    }
    return text
  }

  async function findServer(id: number) {
    const servers = await api.fetchServers()
    return { servers, server: servers.find((s) => s.id === id) }
  }

  ctx.command('nezha', '哪吒监控面板查询')
    .usage(USAGE)
    .example('nezha 状态')
    .action(async ({ session }) => {
      await handleStatus(session!)
    })

  ctx.command('nezha.帮助', '哪吒插件帮助').alias('nezha.help')
    .action(async ({ session }) => {
      await deliver(session!, USAGE)
    })

  ctx.command('nezha.状态', '服务器状态概览').alias('nezha.status')
    .action(async ({ session }) => {
      await handleStatus(session!)
    })

  ctx.command('nezha.详情 <id:number>', '单台服务器详情').alias('nezha.detail')
    .usage('nezha 详情 <服务器ID>')
    .example('nezha 详情 1')
    .action(async ({ session }, id) => {
      if (id == null) return deliver(session!, '❌ 请指定服务器 ID，如：nezha 详情 1')
      await handleDetail(session!, id)
    })

  ctx.command('nezha.服务', '服务监控列表').alias('nezha.service')
    .action(async ({ session }) => {
      await handleServiceList(session!)
    })

  ctx.command('nezha.服务详情 <id:number>', '单个服务监控详情').alias('nezha.service-detail')
    .usage('nezha 服务详情 <服务ID>')
    .example('nezha 服务详情 1')
    .action(async ({ session }, id) => {
      if (id == null) return deliver(session!, '❌ 请指定服务 ID，如：nezha 服务详情 1')
      await handleServiceDetail(session!, id)
    })

  ctx.command('nezha.历史 <id:number> <metric:string> [period:string]', '历史指标趋势')
    .alias('nezha.history')
    .usage('nezha 历史 <服务器ID> <指标> [周期]')
    .example('nezha 历史 1 cpu 1d')
    .action(async ({ session }, id, metric, period) => {
      if (id == null || !metric) {
        return deliver(session!, '📖 用法：nezha 历史 <服务器ID> <指标> [周期]\n'
          + '指标：' + METRIC_LIST.slice(0, 8).join(', ') + ' …\n'
          + '周期：1d（默认）/ 7d / 30d\n'
          + '示例：nezha 历史 1 cpu 1d')
      }
      await handleHistory(session!, id, metric.toLowerCase(), (period || '1d').toLowerCase())
    })

  async function handleStatus(session: Session) {
    let servers
    try {
      servers = await api.fetchServers()
    } catch (error) {
      ctx.logger.error('获取服务器列表失败: %s', (error as Error)?.message)
      return deliver(session!, friendly(error))
    }
    if (!servers.length) return deliver(session!, '📭 暂无服务器')
    const payload = await card('status', statusData(servers), statusText(servers))
    await deliver(session!, payload)
  }

  async function handleDetail(session: Session, id: number) {
    let servers, server
    try {
      const result = await findServer(id)
      servers = result.servers
      server = result.server
    } catch (error) {
      ctx.logger.error('获取服务器详情失败: %s', (error as Error)?.message)
      return deliver(session!, friendly(error))
    }
    if (!servers.length) return deliver(session!, '📭 暂无服务器')
    if (!server) return deliver(session!, '❌ 未找到 ID 为 ' + id + ' 的服务器')
    const payload = await card('server_detail', detailData(server), detailText(server))
    await deliver(session!, payload)
  }

  async function handleServiceList(session: Session) {
    let services
    try {
      services = await api.fetchServices()
    } catch (error) {
      ctx.logger.error('获取服务监控失败: %s', (error as Error)?.message)
      return deliver(session!, friendly(error))
    }
    if (!services.length) return deliver(session!, '📭 暂无服务监控')
    const payload = await card('service_list', serviceListData(services), serviceListText(services))
    await deliver(session!, payload)
  }

  async function handleServiceDetail(session: Session, id: number) {
    let detail
    try {
      detail = await api.fetchServiceDetail(id)
    } catch (error) {
      ctx.logger.error('获取服务详情失败: %s', (error as Error)?.message)
      return deliver(session!, friendly(error) + '\n💡 确认服务 ID 是否正确')
    }
    const payload = await card('service_detail', serviceDetailData(detail), serviceDetailText(detail))
    await deliver(session!, payload)
  }

  async function handleHistory(session: Session, id: number, metric: string, period: string) {
    if (!METRIC_LIST.includes(metric)) {
      return deliver(session!, '❌ 不支持的指标: ' + metric + '\n💡 支持：' + METRIC_LIST.slice(0, 10).join(', ') + ' …')
    }
    if (!PERIOD_LIST.includes(period)) {
      return deliver(session!, '❌ 不支持的周期: ' + period + '\n💡 支持：1d, 7d, 30d')
    }

    let serverName = 'ID:' + id
    let diskTotal: number | undefined
    let points
    try {
      const { servers } = await findServer(id)
      const server = servers.find((s) => s.id === id)
      if (server) {
        serverName = server.name
        diskTotal = server.diskTotal
      }
      points = await api.fetchMetrics(id, metric, period)
    } catch (error) {
      ctx.logger.error('获取历史指标失败: %s', (error as Error)?.message)
      return deliver(session!, friendly(error))
    }

    if (!points.length) return deliver(session!, '📭 服务器 ' + serverName + ' 暂无 ' + metric + ' 历史数据')

    const options = { serverName, metric, period, diskTotal }
    const analysis = analyzeHistory(points, options)
    const payload = await card('history', historyData(analysis, options), historyText(analysis, options))
    await deliver(session!, payload)
  }
}