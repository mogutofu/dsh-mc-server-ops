/**
 * 群服互通 P0：游戏聊天 → QQ 群（**不经过 AI，不产生 token 消耗**）
 *
 * 链路：
 *   logs/latest.log 增量读取 → 解析出聊天/进出事件 → 聚合 → 直连 QQ 开放平台 HTTP API
 *
 * 为什么不走 qqbot 插件：它的入站链路是 中间件 → handleInbound → agent.followup，
 * 出站也只能由模型调用工具触发。这条链路完全绕开它，自己拿 appId/appSecret 发消息。
 *
 * 不依赖任何外部包，只用 Node 内置模块。
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeWaitMs, normalizeCoalesce } from './coalesce.mjs'

// ─────────────────────────── QQ 开放平台 ───────────────────────────

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DEFAULT_API = 'https://api.bot.qq.com'
const TOKEN_SAFETY_MS = 60 * 1000

export class QqApi {
  constructor(options = {}) {
    this.appId = String(options.appId || '')
    this.appSecret = String(options.appSecret || '')
    this.apiBase = String(options.apiBase || DEFAULT_API).replace(/\/+$/, '')
    this.tokenUrl = String(options.tokenUrl || TOKEN_URL)
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.tokenValue = ''
    this.tokenExpiresAt = 0
    this.tokenPromise = null
  }

  configProblem() {
    if (!this.appId) return '缺少 AppID'
    if (!this.appSecret) return '缺少 AppSecret'
    if (typeof this.fetchImpl !== 'function') return '当前 Node 没有 fetch（需要 18+）'
    return ''
  }

  /** 拿 access_token，带缓存；并发时只发一次请求。 */
  async token() {
    const now = Date.now()
    if (this.tokenValue && now < this.tokenExpiresAt) return this.tokenValue
    if (this.tokenPromise) return this.tokenPromise
    const problem = this.configProblem()
    if (problem) throw new Error(problem)
    this.tokenPromise = (async () => {
      const res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      })
      const text = await res.text()
      let doc = {}
      try { doc = JSON.parse(text) } catch { /* 原样 */ }
      if (!res.ok || !doc.access_token) {
        throw new Error(`拿 token 失败（HTTP ${res.status}）：${String(doc.message || doc.error || text).slice(0, 200)}`)
      }
      const ttl = Math.max(60, Number(doc.expires_in) || 7200)
      this.tokenValue = String(doc.access_token)
      this.tokenExpiresAt = Date.now() + ttl * 1000 - TOKEN_SAFETY_MS
      return this.tokenValue
    })()
    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }

  async request(method, path, body) {
    const token = await this.token()
    const init = {
      method,
      headers: {
        Authorization: 'QQBot ' + token,
        'Content-Type': 'application/json',
        'X-Union-Appid': this.appId,
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await this.fetchImpl(this.apiBase + path, init)
    const text = await res.text()
    let doc = {}
    try { doc = text ? JSON.parse(text) : {} } catch { /* 非 JSON */ }
    if (!res.ok) {
      const detail = doc.message || doc.msg || text
      const err = new Error(`QQ API ${method} ${path} → HTTP ${res.status}：${String(detail).slice(0, 200)}`)
      err.status = res.status
      err.body = doc
      throw err
    }
    return doc
  }

  /** 机器人加入的群列表（需要「群管理」权限）。 */
  async listGroups() {
    const doc = await this.request('GET', '/v2/users/@me/groups')
    const list = Array.isArray(doc) ? doc : (Array.isArray(doc.data) ? doc.data : [])
    return list.map((g) => ({
      openid: String(g.group_openid || g.openid || ''),
      name: String(g.group_name || g.name || ''),
    })).filter((g) => g.openid)
  }

  /**
   * 往群里发一条纯文本。
   * @param {string} openid 群 openid
   * @param {string} content 文本（已截断、已清洗）
   * @param {object} opts msgId=被动回复；msgSeq 用于区分同一条 msg_id 的多次回复
   */
  async sendGroupMessage(openid, content, opts = {}) {
    const body = { msg_type: 0, content, msg_seq: Number(opts.msgSeq) || 1 }
    if (opts.msgId) body.msg_id = String(opts.msgId)
    return this.request('POST', `/v2/groups/${encodeURIComponent(openid)}/messages`, body)
  }
}

// ─────────────────────────── 日志增量读取 ───────────────────────────

const COLOR_CODE = /§[0-9a-fk-orx]/gi
const STRIP_PREFIX = /^\[(Not Secure|Not Secure: )\]\s*/i

export function cleanText(text) {
  return String(text || '')
    .replace(COLOR_CODE, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** 解析一行 MC 日志；不是我们关心的事件就返回 null。 */
export function parseLogLine(line) {
  if (!line || line[0] !== '[' && !/^\s*\[/.test(line)) return null
  const m = /\[(?:Server thread|Server\/INFO)[^\]]*\/INFO\]\s*\[[^\]]*\]:\s*(.*)$/.exec(line)
  if (!m) return null
  let rest = m[1].trim()
  if (!rest) return null
  rest = rest.replace(STRIP_PREFIX, '')

  let hit = /^<([A-Za-z0-9_]{1,16})>\s*(.*)$/.exec(rest)
  if (hit) return { type: 'chat', player: hit[1], text: cleanText(hit[2]) }

  hit = /^([A-Za-z0-9_]{1,16}) joined the game\.?$/.exec(rest)
  if (hit) return { type: 'join', player: hit[1] }

  hit = /^([A-Za-z0-9_]{1,16}) left the game\.?$/.exec(rest)
  if (hit) return { type: 'leave', player: hit[1] }

  // 玩家死亡：原版文案是「<名字> was …」或「<名字> died / drowned / blew up …」。
  // 「was / got」后面排除踢人、封禁这类系统消息，避免误当成死亡刷到群里。
  hit = /^([A-Za-z0-9_]{1,16}) (?:(?:was|got) (?!kicked\b|banned\b|whitelisted\b|muted\b|teleported\b|disconnected\b)|died\b|drowned\b|blew up\b|went up in flames\b|burned\b|froze\b|frozen\b|hit the ground\b|fell\b|starved\b|suffocated\b|withered\b|walked into\b|tried to swim\b|impaled\b|pricked\b|struck\b|doomed\b|squashed\b|obliterated\b|sniped\b|pummelled\b|killed\b|slain\b|shot\b|fireballed\b|poked\b|stung\b)/.exec(rest)
  if (hit) return { type: 'death', player: hit[1], text: cleanText(rest) }

  return null
}

/**
 * 解码日志字节。
 * 服务器的 latest.log 用的是系统编码：中文 Windows 下是 GBK，不是 UTF-8。
 * 先按 UTF-8 解，出现替换字符（U+FFFD）就退回 GBK。
 */
const gbkDecoder = (() => {
  try { return new TextDecoder('gbk') } catch { return null }
})()

export function decodeLogBytes(bytes) {
  const utf8 = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)
  if (!utf8.includes('\uFFFD') || !gbkDecoder) return utf8
  try { return gbkDecoder.decode(bytes) } catch { return utf8 }
}

/**
 * 增量跟踪 logs/latest.log。
 * 用轮询而不是 fs.watch：Windows 上 watch 在日志轮转（每天 0 点重命名）时会丢事件。
 */
export function createLogTail(serverDir, onEvent, opts = {}) {
  const file = join(serverDir, 'logs', 'latest.log')
  const intervalMs = Math.max(200, Number(opts.intervalMs) || 500)
  let offset = 0
  let pending = Buffer.alloc(0)
  let timer = null
  let lastSize = -1

  function readNew() {
    let st
    try { st = statSync(file) } catch { return }              // 还没生成
    if (st.size < offset) { offset = 0; pending = Buffer.alloc(0) } // 轮转了，从头来
    if (st.size === offset) return
    let fd
    try {
      fd = openSync(file, 'r')
      const length = st.size - offset
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, offset)
      offset = st.size
      // 按字节切行：中文是多字节，先转字符串再切会在块边界切坏字符
      pending = pending.length ? Buffer.concat([pending, buf]) : buf
      let nl = pending.lastIndexOf(0x0a)
      if (nl < 0) return
      const chunk = pending.subarray(0, nl)
      pending = pending.subarray(nl + 1)
      const text = decodeLogBytes(chunk)
      for (const line of text.split('\n')) {
        const evt = parseLogLine(line.trim())
        if (evt) {
          try { onEvent(evt) } catch { /* 单个事件失败不影响后续 */ }
        }
      }
    } catch { /* 读失败下次再来 */ }
    finally { if (fd !== undefined) { try { closeSync(fd) } catch { } } }
  }

  return {
    /** 从文件末尾开始（只看新内容） */
    startAtEnd() {
      try { offset = statSync(file).size; lastSize = offset } catch { offset = 0 }
    },
    start({ fromStart = false } = {}) {
      if (fromStart) { offset = 0 } else if (offset === 0) { try { offset = statSync(file).size } catch { } }
      if (timer) return
      timer = setInterval(readNew, intervalMs)
      if (timer.unref) timer.unref()
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}

// ─────────────────────────── 桥本身 ───────────────────────────

const MAX_QQ_CHARS = 900
const URL_RE = /https?:\/\/\S+/gi

/** 把一批游戏消息拼成一条 QQ 消息。 */
export function formatBatch(events, opts = {}) {
  const gamePrefix = String(opts.gamePrefix || '')
  const lines = []
  for (const e of events) {
    if (e.type === 'chat') lines.push((gamePrefix ? gamePrefix + ' ' : '') + '<' + e.player + '> ' + e.text)
    else if (e.type === 'join') lines.push('· ' + e.player + ' 加入了游戏')
    else if (e.type === 'leave') lines.push('· ' + e.player + ' 离开了游戏')
    else if (e.type === 'death') lines.push('· ' + e.text)
  }
  if (!lines.length) return ''
  let text = lines.join('\n')
  if (opts.stripUrls !== false) text = text.replace(URL_RE, '[链接]')
  if (text.length > MAX_QQ_CHARS) text = text.slice(0, MAX_QQ_CHARS - 1) + '…'
  return text
}

/**
 * @param {object} deps
 * @param {string} deps.serverDir
 * @param {() => object} deps.readConfig 每次用最新配置
 * @param {(msg: string) => void} [deps.log]
 */
export function createBridge(deps) {
  const serverDir = deps.serverDir
  const log = deps.log || (() => { })
  const api = new QqApi({
    appId: deps.appId,
    appSecret: deps.appSecret,
    apiBase: deps.apiBase,
    tokenUrl: deps.tokenUrl,
    fetchImpl: deps.fetchImpl,
  })
  const online = new Set()
  let queue = []
  let flushTimer = null
  let tail = null
  let running = false
  let sentToday = 0
  let dayKey = new Date().toISOString().slice(0, 10)
  let lastError = ''
  let lastSentAt = ''
  // 自适应合并窗口用：最近几条聊天的到达时间、这一批是什么时候开始攒的、上一次的判定结果
  const recentChatAt = []
  let pendingSince = 0
  let lastWait = null
  const stats = { chats: 0, joins: 0, leaves: 0, deaths: 0, sent: 0, dropped: 0, suppressed: 0 }

  function cfg() {
    const c = deps.readConfig() || {}
    return {
      enabled: c.enabled === true,
      mode: String(c.mode || 'auto'),
      groups: Array.isArray(c.groups) ? c.groups.map(String).filter(Boolean) : [],
      // 进服/退服默认不转发（会刷屏）；死亡消息默认转发
      events: Object.assign({ join: false, leave: false, death: true }, c.events || {}),
      coalesce: normalizeCoalesce(c.coalesce, c.coalesceMs),
      maxPerDay: Math.max(1, Number(c.maxPerDay) || 900),
      gamePrefix: String(c.gamePrefix || ''),
      stripUrls: c.stripUrls !== false,
    }
  }

  /** 有玩家时开启：只在 online 非空时转发 */
  function shouldForward(c) {
    if (!c.enabled) return false
    if (c.mode === 'off') return false
    if (c.mode === 'on') return true
    return online.size > 0
  }

  function rollDay() {
    const key = new Date().toISOString().slice(0, 10)
    if (key !== dayKey) { dayKey = key; sentToday = 0 }
  }

  /**
   * 排下一次合并发送。
   *
   * 每来一条新消息都重算一次：最近聊得越密、在线的人越多，窗口越长；
   * 冷场（quietMs 内没有第二条发言）直接落到 minMs，不会因为“好几小时没人说话”
   * 把间隔算得格外长。窗口上限锁在 pendingSince + maxMs，所以持续刷屏也不会
   * 无限往后拖。
   */
  function schedule(c) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (!queue.length) return
    const now = Date.now()
    if (!pendingSince) pendingSince = now
    const decision = computeWaitMs({ coalesce: c.coalesce, online: online.size, recentChatAt, now })
    const cap = c.coalesce.mode === 'fixed' ? c.coalesce.fixedMs : c.coalesce.maxMs
    const deadline = Math.min(pendingSince + decision.waitMs, pendingSince + cap)
    lastWait = Object.assign({ at: new Date(now).toISOString(), pendingMs: now - pendingSince }, decision)
    flushTimer = setTimeout(() => { void flush() }, Math.max(0, deadline - now))
    if (flushTimer.unref) flushTimer.unref()
  }

  async function flush() {
    flushTimer = null
    pendingSince = 0
    const c = cfg()
    if (!queue.length) return
    const batch = queue
    queue = []
    if (!shouldForward(c)) { stats.suppressed += batch.length; return }
    if (!c.groups.length) { stats.dropped += batch.length; lastError = '还没配置要转发到哪个群'; return }
    const text = formatBatch(batch, { gamePrefix: c.gamePrefix, stripUrls: c.stripUrls })
    if (!text) return
    rollDay()
    if (sentToday >= c.maxPerDay) { stats.dropped += batch.length; lastError = '今日主动消息配额已用完（本地保护上限 ' + c.maxPerDay + '）'; return }
    for (const group of c.groups) {
      try {
        sentToday += 1
        await api.sendGroupMessage(group, text, { msgSeq: sentToday })
        stats.sent += 1
        lastSentAt = new Date().toISOString()
        lastError = ''
      } catch (error) {
        lastError = error && error.message ? error.message : String(error)
        stats.dropped += batch.length
        log('[bridge] 发送失败：' + lastError)
        break
      }
    }
  }

  function onEvent(evt) {
    if (evt.type === 'join') { online.add(evt.player); stats.joins += 1 }
    else if (evt.type === 'leave') { online.delete(evt.player); stats.leaves += 1 }
    else if (evt.type === 'death') stats.deaths += 1
    else if (evt.type === 'chat') stats.chats += 1
    else return

    const c = cfg()
    if (evt.type === 'join' && !c.events.join) return
    if (evt.type === 'leave' && !c.events.leave) return
    if (evt.type === 'death' && !c.events.death) return
    // 自己发的消息（游戏内回显的 QQ 转发）不该再回环：以 [群] 开头的不转发
    if (evt.type === 'chat' && /^\[(群|QQ)\]/.test(evt.text)) return

    if (evt.type === 'chat') {
      recentChatAt.push(Date.now())
      if (recentChatAt.length > c.coalesce.sampleSize) recentChatAt.shift()
    }
    queue.push(evt)
    schedule(c)
  }

  async function seedOnline() {
    // 用 RCON list 补一次，避免 DSH 重启期间漏掉的进出事件
    try {
      const { probePlayers } = await import('./rcon-probe.mjs')
      const names = await probePlayers(serverDir)
      for (const n of names) online.add(n)
      log('[bridge] 启动时在线玩家：' + (names.join(', ') || '无'))
    } catch (error) {
      log('[bridge] 探测在线玩家失败（不影响聊天转发）：' + (error && error.message ? error.message : String(error)))
    }
  }

  return {
    async start() {
      if (running) return
      running = true
      tail = createLogTail(serverDir, onEvent, { intervalMs: 500 })
      tail.startAtEnd()
      tail.start()
      await seedOnline()
      log('[bridge] 已启动，模式=' + cfg().mode)
    },
    stop() {
      running = false
      if (tail) tail.stop()
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      queue = []
      pendingSince = 0
      recentChatAt.length = 0
    },
    isRunning: () => running,
    status() {
      const c = cfg()
      return {
        running,
        mode: c.mode,
        online: [...online],
        queued: queue.length,
        sentToday,
        stats: Object.assign({}, stats),
        lastError,
        lastSentAt,
        coalesce: {
          mode: c.coalesce.mode,
          fixedMs: c.coalesce.fixedMs,
          minMs: c.coalesce.minMs,
          maxMs: c.coalesce.maxMs,
          sampleSize: c.coalesce.sampleSize,
          quietMs: c.coalesce.quietMs,
          fullPlayers: c.coalesce.fullPlayers,
          players: online.size,
          pending: queue.length > 0,
          waitMs: lastWait ? lastWait.waitMs : null,
          activity: lastWait ? lastWait.activity : null,
          gapMs: lastWait ? lastWait.gapMs : null,
          score: lastWait ? lastWait.score : null,
        },
      }
    },
    /** 只用于测试/调试：直接喂一条事件 */
    _feed: onEvent,
    api,
  }
}

/** 把运行状态落盘，方便面板/排查 */
export function writeBridgeState(serverDir, state) {
  try {
    const dir = join(serverDir, 'ops', 'data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bridge-state.json'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, state), null, 2), 'utf8')
  } catch { /* 状态文件写不了不影响主流程 */ }
}
