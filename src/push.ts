import { Context } from 'koishi'
import { formatBytes, formatDateTime, percent } from './format'
import type { NezhaApi } from './api'
import type { Config, PushResult, ServerInfo } from './types'

/** 定时推送概览 + 阈值/离线告警，同一告警有冷却，恢复时补一条 */
export class Pusher {
  private timer?: () => void
  private fired = new Map<string, number>()
  private down = new Set<string>()

  constructor(private ctx: Context, private config: Config, private api: NezhaApi) {}

  start() {
    if (!this.config.push?.enabled) return
    const minutes = Math.max(1, this.config.push.interval || 30)
    this.timer = this.ctx.setInterval(() => this.tick(), minutes * 60 * 1000) as any
    this.ctx.logger.info('nezha 状态推送已开启，每 %d 分钟一次 → %s', minutes, this.config.push.channels.join(', ') || '(未配置频道)')
  }

  stop() {
    if (this.timer) this.timer()
  }

  private cooling(key: string) {
    const cooldown = Math.max(0, this.config.push.cooldown || 30) * 60 * 1000
    const last = this.fired.get(key) || 0
    if (Date.now() - last < cooldown) return true
    this.fired.set(key, Date.now())
    return false
  }

  private evaluate(panel: string, servers: ServerInfo[]): string[] {
    const { thresholdCpu, thresholdMem, thresholdDisk, offline } = this.config.push
    const lines: string[] = []
    for (const server of servers) {
      const key = panel + '|' + server.id
      if (offline && !server.online) {
        if (!this.down.has(key) && !this.cooling(key + '|down')) {
          this.down.add(key)
          lines.push('🔴 ' + server.name + ' 离线（最后活跃 ' + (server.lastActive ? new Date(server.lastActive).toLocaleString('zh-CN') : '未知') + '）')
        }
        continue
      }
      if (this.down.delete(key)) lines.push('🟢 ' + server.name + ' 恢复在线')
      const mem = percent(server.memUsed, server.memTotal)
      const disk = percent(server.diskUsed, server.diskTotal)
      const checks: Array<[string, number, number]> = [
        ['CPU', server.cpu, thresholdCpu],
        ['内存', mem, thresholdMem],
        ['磁盘', disk, thresholdDisk],
      ]
      for (const [label, value, threshold] of checks) {
        if (threshold > 0 && value >= threshold && !this.cooling(key + '|' + label)) {
          lines.push('🚨 ' + server.name + ' ' + label + ' ' + value.toFixed(1) + '% ≥ ' + threshold + '%')
        }
      }
    }
    return lines
  }

  async tick() {
    const channels = (this.config.push.channels || []).filter(Boolean)
    if (!channels.length) return
    let servers: ServerInfo[]
    try {
      servers = await this.api.fetchServers(true)
    } catch (error) {
      this.ctx.logger.warn('推送拉取状态失败: %s', (error as Error).message)
      return
    }
    if (servers.length) {
      const alerts = this.evaluate('', servers)
      const online = servers.filter((s) => s.online).length
      const lines = [
        '📊 服务器状态 · ' + formatDateTime(),
        '总计 ' + servers.length + ' · 在线 ' + online + ' · 离线 ' + (servers.length - online),
      ]
      for (const server of servers) {
        lines.push('· ' + server.name + (server.online ? '' : '（离线）')
          + ' CPU ' + server.cpu.toFixed(0) + '% 内存 ' + percent(server.memUsed, server.memTotal).toFixed(0)
          + '% 磁盘 ' + percent(server.diskUsed, server.diskTotal).toFixed(0) + '%')
      }
      if (alerts.length) {
        lines.push('', '⬇️ 本轮告警（冷却 ' + (this.config.push.cooldown || 0) + ' 分钟）')
        lines.push(...alerts)
      }
      lines.push('', '流量 ↓' + formatBytes(servers.reduce((a, s) => a + s.netInTransfer, 0))
        + ' ↑' + formatBytes(servers.reduce((a, s) => a + s.netOutTransfer, 0)))
      await this.send(channels, lines.join('\n'))
    }
  }

  /** 测试推一条；不传频道就发给配置里的全部频道 */
  async sendTest(channel?: string): Promise<PushResult | undefined> {
    const channels = (channel ? [channel] : this.config.push.channels || []).filter(Boolean)
    if (!channels.length) return undefined
    return this.send(channels, '🔔 nezha 推送测试 · ' + formatDateTime())
  }

  /** 同平台可能有多个 bot（父 bot、各自身份），在线且非隐藏的优先 */
  private botsFor(platform: string, selfId: string) {
    const pool = this.ctx.bots.filter((item) => item.platform === platform)
    const exact = selfId ? pool.filter((item) => item.selfId === selfId) : pool
    return (exact.length ? exact : pool).sort((a, b) => this.score(b) - this.score(a))
  }

  private score(bot: any) {
    return (bot.status === 'online' ? 2 : 0) + (bot.hidden ? 0 : 1)
  }

  /** 纯数字频道号可能是私聊，末位补一次 private: 再试 */
  private targets(id: string) {
    return /^\d+$/.test(id) ? [id, 'private:' + id] : [id]
  }

  private async send(channels: string[], content: string): Promise<PushResult> {
    const result: PushResult = { attempted: 0, ok: 0 }
    for (const channel of channels) {
      const parts = channel.split(':')
      const platform = parts[0]
      const selfId = parts.length >= 3 ? parts[1] : ''
      const id = parts.slice(selfId ? 2 : 1).join(':')
      const bots = this.botsFor(platform, selfId)
      if (!bots.length || !id) {
        result.attempted++
        result.error = '没有可用 bot（格式 platform[:selfId]:channelId）'
        this.ctx.logger.warn('推送频道 %s 没有可用 bot（格式 platform[:selfId]:channelId）', channel)
        continue
      }
      result.attempted++
      let done = false
      for (const bot of bots) {
        for (const target of this.targets(id)) {
          try {
            await bot.sendMessage(target, content)
            done = true
            break
          } catch (error) {
            result.error = (error as Error)?.message || String(error)
          }
        }
        if (done) break
      }
      if (done) result.ok++
      else this.ctx.logger.warn('推送到 %s 失败: %s', channel, result.error)
    }
    return result
  }
}