import type { Locale } from './i18n'

export interface Config {
  baseUrl: string
  apiToken?: string
  locale: Locale
  verifySSL: boolean
  requestTimeout: number
  cacheTTL: number
  enableImage: boolean
  renderTimeout: number
  showSiteName: boolean
  pushTestAuthority: number
  userCooldown: number
  maxTextLength: number
  debug: boolean
  push: PushConfig
  watch: WatchConfig
}

export interface PushConfig {
  enabled: boolean
  /** 推送间隔（分钟） */
  interval: number
  /** 目标会话：platform:channelId */
  channels: string[]
  thresholdCpu: number
  thresholdMem: number
  thresholdDisk: number
  /** 离线告警 */
  offline: boolean
  /** 同一警报重复推送的最小间隔（分钟） */
  cooldown: number
}

export interface WatchConfig {
  enabled: boolean
  /** WebSocket 断线重连退避上限（秒） */
  maxBackoff: number
}

export interface AlertRule {
  id: number
  name: string
  enabled: boolean
  servers: string[]
  rules: string[]
  notificationGroupId: number
  failTriggerTasks: number
  recoverTriggerTasks: number
}

export interface ServerInfo {
  id: number
  name: string
  online: boolean
  cpu: number
  cpuCores: number
  swapUsed: number
  swapTotal: number
  load1: number
  load5: number
  load15: number
  tcpConn: number
  udpConn: number
  processCount: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  uptime: number
  platform: string
  platformVersion: string
  arch: string
  bootTime: number
  netInTransfer: number
  netOutTransfer: number
  netInSpeed: number
  netOutSpeed: number
  lastActive: string
  geoipCountry: string
}

export interface ServiceItem {
  id: number
  name: string
  /** 1 在线 / 0 离线 / -1 未知 */
  status: number
  avgDelay: number
  upPercent: number
  currentUp: number
  currentDown: number
  totalUp: number
  totalDown: number
}

export interface ServiceServerStat {
  serverName: string
  upPercent: number
  avgDelay: number
  totalUp: number
  totalDown: number
}

export interface ServiceDetail {
  name: string
  servers: ServiceServerStat[]
  /** 延迟曲线（period 1d 的 data_points） */
  points: MetricPoint[]
}

export interface MetricPoint {
  ts: number
  value: number
}

/** 常见后端错误都归一成这几种，便于给出可照做的提示 */
export type NezhaErrorKind =
  | 'config'
  | 'auth'
  | 'forbidden'
  | 'rate'
  | 'network'
  | 'timeout'
  | 'server'
  | 'http'
  | 'json'
  | 'tsdb'
  | 'nodata'