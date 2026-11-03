/**
 * Pterodactyl 面板适配器（翼龙面板，客户端 API）。
 *
 * 只用到四个客户端接口：
 *   POST /api/client/servers/{id}/power       body {"signal":"start"|"stop"|"restart"|"kill"}
 *   POST /api/client/servers/{id}/command     body {"command":"say hi"}
 *   GET  /api/client/servers/{id}/resources   取 current_state / CPU / 内存 / 运行时长
 *
 * 鉴权用客户端 API Key（ptlc_ 开头那个），不是账号密码，也不是 application key。
 * 配置在插件设置里：面板地址、服务器 ID（短 UUID）、客户端 Key。
 */

const DEFAULT_TIMEOUT = 15000

export class PterodactylAdapter {
  constructor(options = {}) {
    this.kind = 'panel'
    this.url = String(options.url || '').replace(/\/+$/, '')
    this.serverId = String(options.serverId || '')
    this.clientApiKey = String(options.clientApiKey || '')
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT
  }

  /** 配置齐不齐。缺哪项就说哪项，别让用户猜。 */
  configProblem() {
    const missing = []
    if (!this.url) missing.push('面板地址（如 https://panel.example.com）')
    if (!this.serverId) missing.push('服务器 ID')
    if (!this.clientApiKey) missing.push('客户端 API Key')
    if (missing.length) return '面板适配器还没配好，缺少：' + missing.join('、')
    if (!/^https?:\/\//i.test(this.url)) return '面板地址要以 http:// 或 https:// 开头。'
    if (typeof this.fetchImpl !== 'function') return '当前运行环境没有 fetch，面板适配器用不了。'
    return ''
  }

  _endpoint(tail) {
    return `${this.url}/api/client/servers/${encodeURIComponent(this.serverId)}/${tail}`
  }

  async _request(method, tail, body) {
    const problem = this.configProblem()
    if (problem) return { ok: false, text: problem }
    const init = {
      method,
      headers: {
        Authorization: 'Bearer ' + this.clientApiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(this.timeoutMs) : undefined,
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    let res
    try {
      res = await this.fetchImpl(this._endpoint(tail), init)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      return { ok: false, text: '连不上面板：' + message }
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      let detail = text
      try { detail = JSON.parse(text).errors?.[0]?.detail || text } catch { /* 原样 */ }
      return { ok: false, text: `面板返回 ${res.status}：${String(detail || '(无内容)').slice(0, 300)}` }
    }
    return { ok: true, text }
  }

  /** @param {'start'|'stop'|'restart'|'kill'} signal */
  async _power(signal, label) {
    const r = await this._request('POST', 'power', { signal })
    if (!r.ok) return r
    return { ok: true, text: `${label}指令已发给面板（signal=${signal}）` }
  }

  async start() { return this._power('start', '启动') }
  async stop() { return this._power('stop', '停止') }
  async restart() { return this._power('restart', '重启') }
  async kill() { return this._power('kill', '强杀') }

  async sendCommand(cmd) {
    const command = String(cmd || '').trim().replace(/^\/+/, '')
    if (!command) return { ok: false, text: '空命令，没东西要发。' }
    const r = await this._request('POST', 'command', { command })
    if (!r.ok) return r
    return { ok: true, text: '已通过面板执行：' + command }
  }

  async getStatus() {
    const r = await this._request('GET', 'resources')
    if (!r.ok) return r
    let attrs = {}
    try { attrs = JSON.parse(r.text || '{}').attributes || {} } catch { /* 忽略 */ }
    const state = attrs.current_state || 'unknown'
    const stateText = { running: '运行中', starting: '启动中', stopping: '停止中', offline: '未运行' }[state] || state
    const res = attrs.resources || {}
    const mem = res.memory_bytes ? (res.memory_bytes / 1024 / 1024).toFixed(0) + ' MB' : '-'
    const cpu = typeof res.cpu_absolute === 'number' ? res.cpu_absolute.toFixed(1) + '%' : '-'
    const up = typeof res.uptime === 'number' ? (res.uptime / 60000).toFixed(0) + ' 分钟' : '-'
    return { ok: true, text: `面板：${stateText}  CPU: ${cpu}  内存: ${mem}  运行时长: ${up}` }
  }
}

export default PterodactylAdapter
