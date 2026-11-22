const BYTES_PER_UNIT = 1024

const COUNTRY_FLAGS: Record<string, string> = {
  cn: '🇨🇳', us: '🇺🇸', hk: '🇭🇰', jp: '🇯🇵', kr: '🇰🇷',
  sg: '🇸🇬', uk: '🇬🇧', de: '🇩🇪', fr: '🇫🇷', ru: '🇷🇺',
  au: '🇦🇺', ca: '🇨🇦', in: '🇮🇳', br: '🇧🇷', mx: '🇲🇽',
  it: '🇮🇹', es: '🇪🇸', nl: '🇳🇱', se: '🇸🇪', no: '🇳🇴',
  fi: '🇫🇮', is: '🇮🇸', pl: '🇵🇱', ua: '🇺🇦', tr: '🇹🇷',
  ae: '🇦🇪', sa: '🇸🇦', il: '🇮🇱', za: '🇿🇦', eg: '🇪🇬',
  ng: '🇳🇬', ke: '🇰🇪', tw: '🇹🇼', mo: '🇲🇴', my: '🇲🇾',
  th: '🇹🇭', vn: '🇻🇳', ph: '🇵🇭', id: '🇮🇩', pk: '🇵🇰',
  bd: '🇧🇩', kz: '🇰🇿', uz: '🇺🇿',
}

const OS_ICONS: Record<string, string> = {
  ubuntu: 'fl-ubuntu', debian: 'fl-debian', centos: 'fl-centos',
  rhel: 'fl-centos', fedora: 'fl-fedora', alpine: 'fl-alpine',
  arch: 'fl-archlinux', opensuse: 'fl-opensuse',
  windows: 'fl-windows', mac: 'fl-macos', darwin: 'fl-macos',
}

export const METRIC_DISPLAY_NAMES: Record<string, string> = {
  cpu: 'CPU 使用率',
  memory: '内存使用率',
  swap: 'Swap 使用率',
  disk: '磁盘使用率',
  net_in_speed: '入站速率',
  net_out_speed: '出站速率',
  net_in_transfer: '入站流量',
  net_out_transfer: '出站流量',
  load1: '负载 (1分钟)',
  load5: '负载 (5分钟)',
  load15: '负载 (15分钟)',
  tcp_conn: 'TCP 连接数',
  udp_conn: 'UDP 连接数',
  process_count: '进程数',
  temperature: '温度',
  uptime: '运行时间',
  gpu: 'GPU 使用率',
}

export const METRIC_UNITS: Record<string, string> = {
  cpu: '%', memory: '%', swap: '%', disk: '%',
  net_in_speed: 'bps', net_out_speed: 'bps',
  load1: '', load5: '', load15: '',
  tcp_conn: '个', udp_conn: '个', process_count: '个',
  temperature: '°C', uptime: '秒', gpu: '%',
}

export const PERIOD_LABELS: Record<string, string> = {
  '1d': '过去24小时',
  '7d': '过去7天',
  '30d': '过去30天',
}

export function countryFlag(code?: string) {
  return COUNTRY_FLAGS[(code || '').toLowerCase()] || '🌍'
}

export function osIcon(platform?: string) {
  const lower = (platform || '').toLowerCase()
  if (!lower || lower === 'n/a') return 'fl-tux'
  for (const [key, icon] of Object.entries(OS_ICONS)) {
    if (lower.includes(key)) return icon
  }
  return 'fl-tux'
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  for (const unit of units) {
    if (value < BYTES_PER_UNIT) {
      return unit === 'B' ? `${Math.round(value)} B` : `${value.toFixed(2)} ${unit}`
    }
    value /= BYTES_PER_UNIT
  }
  return `${value.toFixed(2)} PB`
}

export function formatUptime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds || 0))
  if (s < 60) return `${s}秒`
  if (s < 3600) return `${Math.floor(s / 60)}分钟`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h}小时 ${m}分钟`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return `${d}天 ${h}小时`
}

export function formatMetricValue(value: number, metric: string) {
  if (metric === 'disk') return `${value.toFixed(1)}%`
  if (metric === 'net_in_transfer' || metric === 'net_out_transfer') return formatBytes(Math.trunc(value))
  if (metric === 'uptime') return formatUptime(Math.trunc(value))
  return `${value.toFixed(2)}${METRIC_UNITS[metric] || ''}`
}

export function formatTimestamp(ts: number) {
  if (!ts) return ''
  const ms = ts > 1e12 ? ts : ts * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDateTime(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function percent(used: number, total: number) {
  return total > 0 ? (used / total) * 100 : 0
}
