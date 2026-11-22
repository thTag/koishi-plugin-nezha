import { Context } from 'koishi'
import WebSocket from 'ws'
import type { NezhaApi } from './api'
import type { Config } from './types'

/** 订阅面板的实时状态流（/api/v1/ws/server），把快照灌进 API 缓存；断线指数退避重连 */
export class ServerStream {
  private socket?: WebSocket
  private timer?: () => void
  private closed = false
  private attempt = 0

  constructor(private ctx: Context, private api: NezhaApi, private config: Config) {}

  start() {
    this.connect()
  }

  stop() {
    this.closed = true
    if (this.timer) this.timer()
    try {
      this.socket?.close()
    } catch {}
  }

  private url() {
    const base = this.api.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')
    return base + '/api/v1/ws/server'
  }

  private connect() {
    if (this.closed) return
    const headers: Record<string, string> = {}
    if (this.config.apiToken) headers.Authorization = 'Bearer ' + this.config.apiToken
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url(), { headers })
    } catch (error) {
      this.reconnect()
      return
    }
    this.socket = socket

    socket.on('open', () => {
      this.attempt = 0
      this.ctx.logger.debug('实时状态流已连接: %s', this.api.baseUrl)
    })
    socket.on('message', (raw: any) => {
      try {
        const message = JSON.parse(raw.toString())
        const list = Array.isArray(message) ? message
          : Array.isArray(message?.servers) ? message.servers
            : Array.isArray(message?.data) ? message.data
              : Array.isArray(message?.data?.servers) ? message.data.servers
                : undefined
        if (list) this.api.ingestServers(list)
      } catch {}
    })
    socket.on('close', () => {
      if (!this.closed) this.reconnect()
    })
    socket.on('error', (error: any) => {
      this.ctx.logger.debug('实时状态流出错: %s', error?.message)
    })
  }

  private reconnect() {
    if (this.closed) return
    const delay = Math.min(60, Math.max(2, this.config.watch?.maxBackoff || 30)) * 1000
    const wait = Math.min(delay, 2000 * 2 ** Math.min(4, this.attempt++))
    this.timer = setTimeout(() => this.connect(), wait) as any
  }
}
