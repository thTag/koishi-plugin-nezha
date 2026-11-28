import { Context } from 'koishi'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config, ServerInfo, ServiceDetail, ServiceItem } from './types'
import { renderTemplate } from './template'
import {
  METRIC_DISPLAY_NAMES,
  PERIOD_LABELS,
  countryFlag,
  flagSrc,
  formatBytes,
  formatDateTime,
  formatMetricValue,
  formatTimestamp,
  formatUptime,
  osIcon,
  percent,
  resetFlagCache,
  usageBar,
} from './format'

const TEMPLATE_DIR = join(__dirname, '..', 'templates')
const ASSET_DIR = join(__dirname, '..', 'assets')
const LOGO_RE = /src="https:\/\/raw\.githubusercontent\.com\/[^"]*logo\.png"/g
const FONT_CSS_RE = /<link rel="stylesheet" href="https:\/\/fastly\.jsdelivr\.net\/npm\/font-logos@1\/assets\/font-logos\.css">/g

let logoCache: string | undefined
let fontCache: string | undefined

/** 测试用：清掉本地资源缓存 */
export function resetRenderCache() {
  logoCache = undefined
  fontCache = undefined
  resetFlagCache()
}

/** 系统图标字体内置进 HTML：字体文件转 data URI，断网也有图标 */
async function fontStyle() {
  if (fontCache !== undefined) return fontCache
  try {
    const [css, woff2] = await Promise.all([
      readFile(join(ASSET_DIR, 'font-logos.css'), 'utf8'),
      readFile(join(ASSET_DIR, 'font-logos.woff2')),
    ])
    const uri = 'data:font/woff2;base64,' + woff2.toString('base64')
    fontCache = '<style>' + css.replace(/src:url\("[^"]*"\) format\("woff"\),url\("[^"]*"\) format\("woff2"\),url\("[^"]*"\) format\("truetype"\)/, 'src:url("' + uri + '") format("woff2")') + '</style>'
  } catch {
    fontCache = ''
  }
  return fontCache
}

async function logoDataUri() {
  if (logoCache !== undefined) return logoCache
  try {
    const buf = await readFile(join(ASSET_DIR, 'logo.png'))
    logoCache = 'data:image/png;base64,' + buf.toString('base64')
  } catch {
    logoCache = ''
  }
  return logoCache
}

export async function buildHtml(ctx: Context, config: Config, name: string, data: Record<string, any>) {
  let tpl = await readFile(join(TEMPLATE_DIR, name + '.html'), 'utf8')
  const font = await fontStyle()
  if (font) tpl = tpl.replace(FONT_CSS_RE, font)
  const logo = await logoDataUri()
  if (logo) tpl = tpl.replace(LOGO_RE, 'src="' + logo + '"')
  return renderTemplate(tpl, { site_name: '哪吒监控', ...data })
}

export async function renderCard(
  ctx: Context,
  config: Config,
  name: string,
  data: Record<string, any>,
): Promise<Buffer> {
  const html = await buildHtml(ctx, config, name, data)
  const page = await (ctx as any).puppeteer.page()
  try {
    if (typeof (page as any).setViewport === 'function') {
      await (page as any).setViewport({ width: 820, height: 600, deviceScaleFactor: 2 })
    }
    await page.setContent(html, { waitUntil: 'load', timeout: config.renderTimeout })
    const shot: any = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.isBuffer(shot) ? shot : Buffer.from(shot)
  } finally {
    try {
      if (typeof (page as any).close === 'function') await (page as any).close()
    } catch {}
  }
}

/* ------------------------------ 模板数据 ------------------------------ */

export function statusData(servers: ServerInfo[]) {
  const online = servers.filter((s) => s.online).length
  return {
    total: servers.length,
    online,
    offline: servers.length - online,
    servers: servers.map((s) => ({
      id: s.id,
      name: s.name,
      online: s.online,
      cpu: s.cpu,
      mem_percent: percent(s.memUsed, s.memTotal),
      disk_percent: percent(s.diskUsed, s.diskTotal),
      os_icon: osIcon(s.platform),
      country_code: (s.geoipCountry || 'un').toLowerCase(),
      flag: countryFlag(s.geoipCountry),
      flag_src: flagSrc(s.geoipCountry),
    })),
    update_time: formatDateTime(),
  }
}

export function detailData(server: ServerInfo) {
  return {
    server: {
      name: server.name,
      online: server.online,
      cpu: server.cpu,
      cpu_bar: usageBar(server.cpu),
      mem_percent: percent(server.memUsed, server.memTotal),
      mem_used: formatBytes(server.memUsed),
      mem_total: formatBytes(server.memTotal),
      disk_percent: percent(server.diskUsed, server.diskTotal),
      mem_bar: usageBar(percent(server.memUsed, server.memTotal)),
      disk_bar: usageBar(percent(server.diskUsed, server.diskTotal)),
      disk_used: formatBytes(server.diskUsed),
      disk_total: formatBytes(server.diskTotal),
      uptime: formatUptime(server.uptime),
      platform: server.platform,
      platform_version: server.platformVersion,
      net_in: formatBytes(server.netInTransfer),
      net_out: formatBytes(server.netOutTransfer),
      net_in_speed: formatBytes(server.netInSpeed) + '/s',
      net_out_speed: formatBytes(server.netOutSpeed) + '/s',
      last_active: formatLastActive(server.lastActive),
      country_code: (server.geoipCountry || 'un').toLowerCase(),
      flag: countryFlag(server.geoipCountry),
      flag_src: flagSrc(server.geoipCountry),
      arch: server.arch || 'N/A',
      cpu_cores: server.cpuCores || 'N/A',
      boot_time: server.bootTime ? formatDateTime(new Date(server.bootTime * 1000)) : 'N/A',
      load1: server.load1.toFixed(2),
      load5: server.load5.toFixed(2),
      load15: server.load15.toFixed(2),
      tcp_conn: server.tcpConn,
      udp_conn: server.udpConn,
      process_count: server.processCount,
      swap_used: formatBytes(server.swapUsed),
      swap_total: formatBytes(server.swapTotal),
    },
    update_time: formatDateTime(),
  }
}

function serviceStatusText(status: number) {
  if (status === 1) return { icon: '🟢', text: '连接正常', cls: 'online' }
  if (status === 0) return { icon: '🔴', text: '连接异常', cls: 'offline' }
  return { icon: '⚪', text: '未知', cls: 'unknown' }
}

export function serviceListData(services: ServiceItem[]) {
  const online = services.filter((s) => s.status === 1).length
  const offline = services.filter((s) => s.status === 0).length
  return {
    total: services.length,
    online,
    offline,
    services: services.map((s) => {
      const st = serviceStatusText(s.status)
      return {
        id: s.id,
        name: s.name,
        status: st.text,
        status_class: st.cls,
        up_percent: s.upPercent,
        avg_delay: s.avgDelay > 0 ? s.avgDelay.toFixed(1) + 'ms' : 'N/A',
      }
    }),
    update_time: formatDateTime(),
  }
}

export function serviceDetailData(detail: ServiceDetail) {
  let totalUp = 0
  let totalDown = 0
  let totalDelay = 0
  const servers = detail.servers.map((svr) => {
    totalUp += svr.totalUp
    totalDown += svr.totalDown
    totalDelay += svr.avgDelay
    const statusClass = svr.upPercent >= 95 ? 'online' : svr.upPercent >= 50 ? 'offline' : 'warning'
    return {
      server_name: svr.serverName,
      up_percent: svr.upPercent,
      avg_delay: svr.avgDelay > 0 ? svr.avgDelay.toFixed(1) + 'ms' : 'N/A',
      status_class: statusClass,
      status_text: svr.upPercent >= 95 ? '连接正常' : '连接异常',
    }
  })
  const checks = totalUp + totalDown
  const overallUp = checks > 0 ? (totalUp / checks) * 100 : 0
  return {
    service_name: detail.name,
    servers,
    overall_up_percent: overallUp,
    overall_avg_delay: detail.servers.length ? (totalDelay / detail.servers.length).toFixed(1) + 'ms' : 'N/A',
    total_checks: checks,
    overall_status_text: overallUp >= 95 ? '连接正常' : '连接异常',
    overall_status_class: overallUp >= 95 ? 'online' : overallUp >= 50 ? 'offline' : 'unknown',
    update_time: formatDateTime(),
  }
}

export interface HistoryOptions {
  serverName: string
  metric: string
  period: string
  diskTotal?: number
}

export interface HistoryAnalysis {
  current: number
  max: number
  min: number
  avg: number
  maxTime: string
  minTime: string
  startTime: string
  midTime: string
  endTime: string
  points: string
  count: number
}

/** 削峰后生成 SVG 折线点，统计值仍用原始数据（与原插件一致） */
export function analyzeHistory(rawPoints: { ts: number; value: number }[], options: HistoryOptions): HistoryAnalysis {
  const values: number[] = []
  const timestamps: number[] = []
  for (const point of rawPoints) {
    if (point.value === undefined || point.value === null || !Number.isFinite(point.value)) continue
    let value = point.value
    if (options.metric === 'disk' && options.diskTotal && options.diskTotal > 0) {
      value = (value / options.diskTotal) * 100
    }
    values.push(value)
    timestamps.push(point.ts)
  }
  if (!values.length) {
    return { current: 0, max: 0, min: 0, avg: 0, maxTime: '', minTime: '', startTime: '', midTime: '', endTime: '', points: '', count: 0 }
  }

  const clipped = values.slice()
  if (clipped.length > 2) {
    const mean = clipped.reduce((a, b) => a + b, 0) / clipped.length
    const std = Math.sqrt(clipped.reduce((a, b) => a + (b - mean) ** 2, 0) / clipped.length)
    const limit = mean + 3 * std
    for (let i = 0; i < clipped.length; i++) clipped[i] = Math.min(clipped[i], limit)
  }

  const max = Math.max(...values)
  const min = Math.min(...values)
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  const maxIdx = values.indexOf(max)
  const minIdx = values.indexOf(min)
  const midIdx = Math.floor(timestamps.length / 2)

  let points = ''
  if (clipped.length > 1) {
    // 点太多时按桶取均值再画，避免 30 秒粒度在 600px 里挤成竖条
    const MAX_POINTS = 360
    const plot = clipped.length > MAX_POINTS
      ? Array.from({ length: MAX_POINTS }, (_, bucket) => {
        const from = Math.floor((bucket * clipped.length) / MAX_POINTS)
        const to = Math.max(from + 1, Math.floor(((bucket + 1) * clipped.length) / MAX_POINTS))
        let sum = 0
        for (let i = from; i < to; i++) sum += clipped[i]
        return sum / (to - from)
      })
      : clipped
    // 再做一次滑动平均，去掉探测抖动
    const smooth = plot.map((_, i) => {
      const from = Math.max(0, i - 3)
      const to = Math.min(plot.length, i + 4)
      let sum = 0
      for (let j = from; j < to; j++) sum += plot[j]
      return sum / (to - from)
    })
    const lo = Math.min(...smooth)
    const hi = Math.max(...smooth)
    const range = hi !== lo ? hi - lo : 1
    points = smooth
      .map((v, i) => {
        const x = (i / Math.max(smooth.length - 1, 1)) * 600
        const y = 140 - ((v - lo) / range) * 120 - 10
        return x.toFixed(1) + ',' + y.toFixed(1)
      })
      .join(' ')
  }

  return {
    current: values[values.length - 1],
    max,
    min,
    avg,
    maxTime: formatTimestamp(timestamps[maxIdx]),
    minTime: formatTimestamp(timestamps[minIdx]),
    startTime: formatTimestamp(timestamps[0]),
    midTime: formatTimestamp(timestamps[midIdx]),
    endTime: formatTimestamp(timestamps[timestamps.length - 1]),
    points,
    count: values.length,
  }
}

export function historyData(analysis: HistoryAnalysis, options: HistoryOptions) {
  const metric = options.metric
  return {
    server_name: options.serverName,
    metric_name: METRIC_DISPLAY_NAMES[metric] || metric,
    period_label: PERIOD_LABELS[options.period] || options.period,
    current_value: formatMetricValue(analysis.current, metric),
    max_value: formatMetricValue(analysis.max, metric),
    max_time: analysis.maxTime,
    min_value: formatMetricValue(analysis.min, metric),
    min_time: analysis.minTime,
    avg_value: formatMetricValue(analysis.avg, metric),
    points: analysis.points,
    start_time: analysis.startTime,
    mid_time: analysis.midTime,
    end_time: analysis.endTime,
    update_time: formatDateTime(),
  }
}

/* ------------------------------ 文字降级 ------------------------------ */

function formatLastActive(raw: string) {
  if (!raw) return '未知'
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? raw : formatDateTime(date)
}

export function statusText(servers: ServerInfo[]) {
  const online = servers.filter((s) => s.online).length
  const lines = [
    '🖥️ 哪吒监控 · 服务器状态',
    '总计 ' + servers.length + ' · 在线 ' + online + ' · 离线 ' + (servers.length - online),
    '',
  ]
  for (const s of servers) {
    lines.push(s.id + '. ' + s.name + ' ' + countryFlag(s.geoipCountry) + ' ' + (s.online ? '在线' : '离线'))
    lines.push(
      '   CPU ' + s.cpu.toFixed(1) + '% · 内存 ' + percent(s.memUsed, s.memTotal).toFixed(1)
      + '% · 磁盘 ' + percent(s.diskUsed, s.diskTotal).toFixed(1) + '%',
    )
  }
  lines.push('', '更新于 ' + formatDateTime())
  return lines.join('\n')
}

export function detailText(server: ServerInfo) {
  return [
    '🖥️ ' + server.name + ' ' + countryFlag(server.geoipCountry) + ' ' + (server.online ? '在线' : '离线'),
    'ID：' + server.id,
    '系统：' + server.platform + ' ' + server.platformVersion,
    '运行时间：' + formatUptime(server.uptime),
    'CPU：' + server.cpu.toFixed(1) + '%',
    '内存：' + percent(server.memUsed, server.memTotal).toFixed(1) + '% ('
      + formatBytes(server.memUsed) + ' / ' + formatBytes(server.memTotal) + ')',
    '磁盘：' + percent(server.diskUsed, server.diskTotal).toFixed(1) + '% ('
      + formatBytes(server.diskUsed) + ' / ' + formatBytes(server.diskTotal) + ')',
    '架构：' + (server.arch || 'N/A') + ' · 核心数：' + (server.cpuCores || 'N/A'),
    '负载：' + server.load1.toFixed(2) + ' / ' + server.load5.toFixed(2) + ' / ' + server.load15.toFixed(2),
    '连接：TCP ' + server.tcpConn + ' · UDP ' + server.udpConn + ' · 进程 ' + server.processCount,
    'Swap：' + formatBytes(server.swapUsed) + ' / ' + formatBytes(server.swapTotal),
    '速率：↓ ' + formatBytes(server.netInSpeed) + '/s ↑ ' + formatBytes(server.netOutSpeed) + '/s',
    '入站流量：' + formatBytes(server.netInTransfer),
    '出站流量：' + formatBytes(server.netOutTransfer),
    '启动时间：' + (server.bootTime ? formatDateTime(new Date(server.bootTime * 1000)) : 'N/A'),
    '最后活跃：' + formatLastActive(server.lastActive),
  ].join('\n')
}

export function serviceListText(services: ServiceItem[]) {
  const online = services.filter((s) => s.status === 1).length
  const offline = services.filter((s) => s.status === 0).length
  const lines = [
    '📡 服务监控',
    '总计 ' + services.length + ' · 在线 ' + online + ' · 离线 ' + offline,
    '',
  ]
  for (const s of services) {
    const st = serviceStatusText(s.status)
    lines.push(st.icon + ' ' + s.name + ' (ID ' + s.id + ') · 可用率 ' + s.upPercent.toFixed(2) + '%'
      + ' · 延迟 ' + (s.avgDelay > 0 ? s.avgDelay.toFixed(1) + 'ms' : 'N/A'))
  }
  lines.push('', '更新于 ' + formatDateTime())
  return lines.join('\n')
}

export function serviceDetailText(detail: ServiceDetail) {
  const data = serviceDetailData(detail)
  const lines = [
    '📋 ' + data.service_name + ' ' + data.overall_status_text,
    '总可用率：' + data.overall_up_percent.toFixed(2) + '%',
    '平均延迟：' + data.overall_avg_delay,
    '监控次数：' + data.total_checks,
    '关联服务器：' + data.servers.length,
    '',
  ]
  for (const svr of data.servers) {
    lines.push('· ' + svr.server_name + '：' + svr.up_percent.toFixed(2) + '% · ' + svr.avg_delay + ' · ' + svr.status_text)
  }
  lines.push('', '更新于 ' + data.update_time)
  return lines.join('\n')
}

export function historyText(analysis: HistoryAnalysis, options: HistoryOptions) {
  const metric = options.metric
  return [
    '📈 ' + options.serverName + ' · ' + (METRIC_DISPLAY_NAMES[metric] || metric),
    PERIOD_LABELS[options.period] || options.period,
    '',
    '当前：' + formatMetricValue(analysis.current, metric),
    '最高：' + formatMetricValue(analysis.max, metric) + (analysis.maxTime ? ' (' + analysis.maxTime + ')' : ''),
    '最低：' + formatMetricValue(analysis.min, metric) + (analysis.minTime ? ' (' + analysis.minTime + ')' : ''),
    '平均：' + formatMetricValue(analysis.avg, metric),
    '采样：' + analysis.count + ' 个点（' + analysis.startTime + ' ~ ' + analysis.endTime + '）',
  ].join('\n')
}

export function splitText(text: string, maxLength: number) {
  const limit = Math.max(50, maxLength || 1800)
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}