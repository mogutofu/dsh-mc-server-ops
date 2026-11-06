/**
 * 合并窗口（coalesce）计算。
 *
 * 目标：人多、话密的时候多攒一会儿再发（少刷屏、省主动消息配额）；
 * 人少、话稀的时候尽快发出去（别让一两条消息等半天）。
 *
 * 两个硬约束：
 * 1. 只用「安静窗口内」的相邻两条发言间隔算节奏，长时间没人说话不会被算成“间隔很长”；
 * 2. 结果永远夹在 [minMs, maxMs] 之间，再怎么调也不会出现离奇的超长等待。
 *
 * 纯函数，不碰 IO，方便单独测。
 */

export const COALESCE_DEFAULTS = Object.freeze({
  mode: 'auto',
  minMs: 1000,
  maxMs: 6000,
  sampleSize: 3,
  quietMs: 20000,
  fullPlayers: 6,
  fastMs: 2000,
})

/** 自动模式里两个因子各占多少：聊天节奏为主，在线人数为辅。 */
const CHAT_WEIGHT = 0.6
const PLAYER_WEIGHT = 0.4

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 把配置里的原始值收敛成一个可用、且自洽的合并配置。
 * @param {object} raw 配置里的 coalesce 对象（可能缺字段、可能是脏数据）
 * @param {number} [legacyFixedMs] 旧版的 bridge.coalesceMs，作为固定窗口的兜底
 */
export function normalizeCoalesce(raw, legacyFixedMs) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const minMs = clamp(num(c.minMs, COALESCE_DEFAULTS.minMs), 300, 120000)
  const maxMs = clamp(num(c.maxMs, COALESCE_DEFAULTS.maxMs), minMs, 300000)
  return {
    mode: c.mode === 'fixed' ? 'fixed' : 'auto',
    fixedMs: clamp(num(c.fixedMs, num(legacyFixedMs, 3000)), 300, 300000),
    minMs,
    maxMs,
    sampleSize: clamp(Math.round(num(c.sampleSize, COALESCE_DEFAULTS.sampleSize)), 2, 6),
    quietMs: clamp(num(c.quietMs, COALESCE_DEFAULTS.quietMs), 1000, 3600000),
    fullPlayers: clamp(num(c.fullPlayers, COALESCE_DEFAULTS.fullPlayers), 1, 128),
    fastMs: clamp(num(c.fastMs, COALESCE_DEFAULTS.fastMs), 200, 120000),
  }
}

/**
 * 看最近的发言节奏。
 * @param {number[]} recentChatAt 最近几条聊天的接收时间戳（毫秒）
 * @param {number} now 当前时间
 * @returns {{activity:number, gapMs:number|null, samples:number}}
 *   activity 0=冷场 1=最快；gapMs 是相邻两条的平均间隔；samples 是真正参与计算的条数。
 */
export function chatActivity(recentChatAt, now, coalesce) {
  const quietMs = coalesce.quietMs
  const times = (Array.isArray(recentChatAt) ? recentChatAt : [])
    .filter((t) => Number.isFinite(t) && now - t <= quietMs)
    .slice(-coalesce.sampleSize)
  // 一条也算不出间隔，按冷场处理：宁可直接发，也别拖
  if (times.length < 2) return { activity: 0, gapMs: null, samples: times.length }
  const gaps = []
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1])
  const gapMs = gaps.reduce((a, b) => a + b, 0) / gaps.length
  // gap <= fastMs 算满活跃，gap >= quietMs 算冷场，中间线性
  const span = Math.max(1, quietMs - coalesce.fastMs)
  const activity = clamp((quietMs - gapMs) / span, 0, 1)
  return { activity, gapMs, samples: times.length }
}

/**
 * 算出这一批消息该等多久再合并发送。
 * @param {{coalesce:object, online?:number, recentChatAt?:number[], now?:number}} input
 * @returns {{waitMs:number, mode:string, activity:number, gapMs:number|null, players:number, score:number}}
 */
export function computeWaitMs(input) {
  const c = input && input.coalesce ? input.coalesce : normalizeCoalesce()
  const now = Number.isFinite(input && input.now) ? input.now : Date.now()
  const players = Math.max(0, num(input && input.online, 0))
  if (c.mode === 'fixed') {
    return { waitMs: Math.round(c.fixedMs), mode: 'fixed', activity: 0, gapMs: null, players, score: 1 }
  }
  const chat = chatActivity(input && input.recentChatAt, now, c)
  const playerFactor = clamp(players / c.fullPlayers, 0, 1)
  const score = clamp(CHAT_WEIGHT * chat.activity + PLAYER_WEIGHT * playerFactor, 0, 1)
  const waitMs = Math.round(clamp(c.minMs + (c.maxMs - c.minMs) * score, c.minMs, c.maxMs))
  return { waitMs, mode: 'auto', activity: chat.activity, gapMs: chat.gapMs, players, score }
}
