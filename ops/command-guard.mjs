/**
 * 静态命令拦截器 —— RCON 命令出网前的最后一道闸。
 *
 * 只拦「大规模杀伤 / 不可逆」这一类：一条命令就能把整个服务器搞崩、
 * 或者把所有人的号踢下线，事后只能回档。其余命令交给上层判断
 * （权限校验 + 投票放行），这里不做业务判断。
 *
 * 用法：
 *   import { guardCommand } from './command-guard.mjs'
 *   const v = guardCommand('kill @a', { id: 'xxx', owner: false })
 *   if (!v.ok) throw new Error(v.reason)
 *
 * 分级（按服主定的策略）：
 *   - kill @a / kill @e / kill @r / kill *   —— 谁都不行
 *   - kick @a / kick @e                      —— 谁都不行
 *   - whitelist off / whitelist clear        —— 谁都不行
 *   - execute ... run kill @a|@e             —— 谁都不行（换个写法绕不过去）
 *   - stop                                   —— 非服主不行
 */

/** 起手就是聊天/标题类指令时不拦（内容里出现 kill @a 只是打字，不会执行）。 */
const CHAT_PREFIX = /^(say|tell|msg|w|tellraw|me|title|subtitle|actionbar|broadcast)\b/i

/** 谁都不许发的命令。 */
const BLOCKED_ALL = [
  {
    re: /^kill\s+(@[ae]\b|@r\b|\*)/i,
    reason: 'kill @a / @e / @r 会一次干掉全部玩家或实体，服务器基本等于当场崩掉。真要清场用 kick 单个玩家，或者先备份再动手。',
  },
  {
    re: /^kick\s+@[ae]\b/i,
    reason: 'kick @a / @e 一次踢光所有人，正在跑的任务和区块加载全会断。要踢人请写具体名字。',
  },
  {
    re: /^whitelist\s+(off|clear)\b/i,
    reason: '关白名单/清空白名单会让任何知道地址的人都能进来。要临时放人可以 whitelist add 具体名字。',
  },
  {
    re: /^execute\b[\s\S]*\brun\s+kill\s+(@[ae]\b|@r\b|\*)/i,
    reason: 'execute ... run kill @a 绕了一道照样是清场，拦。',
  },
]

/** 只有服主能发的命令。 */
const BLOCKED_PLAYER = [
  {
    re: /^stop\b/i,
    reason: '停服只有服主能做（会断开所有在线玩家，world 也可能来不及存盘）。',
  },
]

/** 归一化：去前导斜杠、压空白，让 `/kill  @a` 和 `kill @a` 一样被识别。 */
function normalize(cmd) {
  let s = String(cmd === undefined || cmd === null ? '' : cmd).trim()
  if (s.startsWith('/')) s = s.slice(1).trim()
  return s.replace(/\s+/g, ' ')
}

/**
 * 判断 actor 是不是服主。
 * 既接受 '34EB...' 这种裸 ID，也接受 { id, owner } 这种已判定过的对象。
 */
export function isOwnerActor(actor) {
  if (actor && typeof actor === 'object') return actor.owner === true
  return false
}

/**
 * 拦截判定。
 * @param {string} cmd 要发给 RCON 的原始命令（不带前导斜杠也可以）
 * @param {string|{id?:string,owner?:boolean}} actor 发起人；对象形式可带 owner 标记
 * @returns {{ok: boolean, reason?: string, rule?: string}}
 */
export function guardCommand(cmd, actor) {
  const text = normalize(cmd)
  if (!text) return { ok: false, reason: '空命令，没东西要发。', rule: 'empty' }

  // 聊天类指令只是把字打在公屏上，不执行，放行
  if (CHAT_PREFIX.test(text)) return { ok: true }

  for (const rule of BLOCKED_ALL) {
    if (rule.re.test(text)) return { ok: false, reason: rule.reason, rule: rule.re.source }
  }

  if (!isOwnerActor(actor)) {
    for (const rule of BLOCKED_PLAYER) {
      if (rule.re.test(text)) return { ok: false, reason: rule.reason, rule: rule.re.source }
    }
  }

  return { ok: true }
}

/** 方便日志/报错用的一行摘要。 */
export function describeActor(actor) {
  if (actor && typeof actor === 'object') {
    return (actor.id ? String(actor.id) : 'unknown') + (actor.owner ? '(owner)' : '(player)')
  }
  return String(actor || 'unknown')
}

export default guardCommand
