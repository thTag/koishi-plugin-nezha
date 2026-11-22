export interface Config {
  baseUrl: string
  apiToken: string
  adminToken: string
  verifySSL: boolean
  requestTimeout: number
  cacheTTL: number
  enableImage: boolean
  renderTimeout: number
  cdnBase: string
  maxTextLength: number
  debug: boolean
}

export interface ServerInfo {
  id: number
  name: string
  online: boolean
  cpu: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  uptime: number
  platform: string
  platformVersion: string
  netInTransfer: number
  netOutTransfer: number
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
}

export interface MetricPoint {
  ts: number
  value: number
}
