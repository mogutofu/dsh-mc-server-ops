import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { guardCommand } from './ops/command-guard.mjs'
import { createAdapter } from './ops/adapters/index.mjs'
import { createBridge, writeBridgeState, QqApi, createLogTail } from './ops/qq-bridge.mjs'
import { ensureQqbotInboundHook } from './ops/qqbot-hook.mjs'
import {
  EXCHANGE_AGENT_TASKS,
  buildExchangeRetryPrompt,
  buildExchangeUserPrompt,
  exchangeSystemPrompt,
  limitExchangeContext,
  limitExchangeMessage,
  normalizeExchangeRequest,
  parseExchangeReply,
} from './ops/mc-exchange.mjs'

// 运行期路径：apply() 里按配置初始化。服务器目录、脚本位置都可以在设置里改。
const paths = { serverDir: '', script: '', ownersFile: '', flipLog: '' }

// 本机界面会话（桌面端 / CLI）的 id 形如 session-xxxx；QQ 机器人建出来的会话是纯 UUID。
function isLocalSession(id) { return /^(session-|local-)/i.test(String(id || '')) }

// 人设默认值。安装后可以在设置里改名字和语气，这里只是小铜的出厂设定。
const DEFAULT_PERSONA = '你在 QQ 群里叫「小铜」，二十来岁，平时就泡在这台 Minecraft 服务器里，机器、物流、红石都能聊两句，服务器出毛病也能修。你不是客服，说话自然点，别端着，也别卖萌。'
// 服主用 mc_server 执行过一次操作后，10 分钟内允许该会话使用文件/命令类工具。
const GRANT_MS = 12 * 60 * 60 * 1000
// 任何会话都能用的只读工具
const OPEN_READ_TOOLS = ['read', 'glob', 'grep']
// 查询类动作：玩家和白名单新玩家都能用（不做服务器变更）
const READ_ONLY_ACTIONS = ['whoami', 'help', 'status', 'players', 'logs', 'crashinfo', 'my-players', 'bind-player', 'unbind-player', 'vote-start', 'vote-approve', 'vote-reject', 'vote-status']
// 需要服主授权才能用的工具
const GUARDED_TOOLS = ['write', 'edit', 'pwsh', 'web_fetch', 'web_search']
// 发文件到 QQ 的工具（玩家可用，但敏感文件除外）
const SEND_TOOLS = ['qqbot_send_file', 'present']
const SENSITIVE_PATH = /(server\.properties|ops[\\/]+data[\\/]+|\.credentials|\.env\b|owners\.json|config\.json|\.pem\b|\.key\b)/i
// 玩家可以改的范围：KubeJS 的 server_scripts（配方脚本）
// 玩家可以改的范围：服务器目录下除敏感区之外的文件（修配置、修脚本用）
function normalizePath(p) { return String(p || '').replace(/\//g, '\\').toLowerCase() }

// 永远不许玩家碰的东西（和投票无关，改设置也解不开）
const ALWAYS_DENY_SOURCE = '\\.dsh|credential|\\.key$|\\.pem$|\\.env$|ops\\.json|banned-|usercache\\.json|eula\\.txt|server\\.jar|\\.exe$|\\.dll$|\\.lnk$'
// 受保护路径：可在设置里改（默认 world / ops/data / whitelist），改动这些位置要走群友投票
const DEFAULT_PROTECTED = ['world', 'ops/data', 'whitelist']
let PROTECTED_PATHS = DEFAULT_PROTECTED.slice()
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function protectedSource() {
  const parts = PROTECTED_PATHS.map((raw) => {
    const p = String(raw || '').trim()
    if (!p) return ''
    const n = normalizePath(p).replace(/\\+$/, '')
    if (n === 'world') return 'world(_nether|_the_end)?[\\\\/]'
    if (n === 'ops\\data') return 'ops[\\\\/]+data'
    if (n === 'whitelist' || n === 'whitelist.json') return 'whitelist\\.json'
    return escapeRegExp(n) + '(?:[\\\\/]|$)'
  }).filter(Boolean)
  return '(' + parts.concat([ALWAYS_DENY_SOURCE]).join('|') + ')'
}
function isProtectedPath(target) { return new RegExp(protectedSource(), 'i').test(normalizePath(target)) }
function setProtectedPaths(list) {
  const next = Array.isArray(list) ? list.map((x) => String(x)).filter((x) => x.trim()) : []
  PROTECTED_PATHS = next.length ? next : DEFAULT_PROTECTED.slice()
}
function isPlayerWritable(target) {
  const root = normalizePath(paths.serverDir).replace(/\\+$/, '') + '\\'
  const t = normalizePath(target)
  if (!root || !t.startsWith(root)) return false
  if (t.includes('..')) return false
  return !isProtectedPath(t)
}
// 只读命令白名单：只允许这些开头/包含的命令查询
const READONLY_CMD = /\b(Get-Content|Get-ChildItem|Get-Item|Get-ItemProperty|Select-String|Select-Object|Where-Object|Sort-Object|Measure-Object|Format-Table|Format-List|Write-Output|Write-Host|Test-Path|Resolve-Path|Split-Path|Join-Path|Get-Process|Get-Service|Get-CimInstance|Get-ComputerInfo|Get-Date|Get-Location|Get-FileHash|Get-Acl|whoami|hostname|systeminfo|tasklist|dir|ls|cat|type|more|findstr|tree)\b/i
// 写文件 / 执行 / 联网下载 / 进程控制等危险命令
const DANGEROUS_CMD = /(Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Set-Content|Add-Content|Out-File|Clear-Content|Set-Item|Set-ItemProperty|New-ItemProperty|Start-Process|Stop-Process|Invoke-Expression|\biex\b|Invoke-WebRequest|Invoke-RestMethod|\bcurl\b|\bwget\b|Start-Job|schtasks|\breg\b|\bsc\b|format|diskpart|shutdown|taskkill|Stop-Computer|Restart-Computer|Set-ExecutionPolicy|New-Service|Set-Service|WriteAll| AppendAll|::Delete|CreateDirectory|DownloadFile|DownloadString|\bdel\b|\berase\b|\brd\b|rmdir|\brm\b)/i

const grants = new Map()

function readOwners() {
  if (!paths.ownersFile) return []
  try {
    const raw = readFileSync(paths.ownersFile, 'utf8').replace(/^\uFEFF/, '')
    const doc = JSON.parse(raw)
    return Array.isArray(doc.owners) ? doc.owners.map((x) => String(x)) : []
  } catch {
    return []
  }
}

function isOwner(actor) {
  return readOwners().includes(actor)
}

// ─────────────────── 配置备份（防更新重置）───────────────────
// 插件更新后，profile 里的配置行有可能被包内的默认值覆盖。每次保存/启动都在
// ops/data/config-backup.json 留一份，启动时如果发现「当前配置全是默认值」而备份不是，
// 就用备份顶回去，避免用户配好的东西被重置。

function configBackupPath(serverDir) {
  return join(serverDir, 'ops', 'data', 'config-backup.json')
}

function readConfigBackup(serverDir) {
  try {
    const file = configBackupPath(serverDir)
    if (!existsSync(file)) return null
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!doc || typeof doc.config !== 'object' || doc.config === null) return null
    return doc.config
  } catch { return null }
}

function writeConfigBackup(serverDir, cfg) {
  try {
    if (!cfg || typeof cfg !== 'object' || !Object.keys(cfg).length) return
    const file = configBackupPath(serverDir)
    mkdirSync(dirname(file), { recursive: true })
    // 备份写进服务器目录，玩家用 read 就能看到；把密钥类字段剔掉，只留非敏感配置。
    const safe = JSON.parse(JSON.stringify(cfg))
    const scrub = (obj, keys) => { if (!obj || typeof obj !== 'object') return; for (const k of keys) if (k in obj) obj[k] = '' }
    scrub(safe.server || {}, ['rconPassword'])
    scrub(safe.bridge || {}, ['appSecret'])
    scrub(safe.panel || {}, ['clientApiKey'])
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), config: safe }, null, 2), 'utf8')
  } catch { /* 备份写不了不影响主流程 */ }
}

/** 当前配置是否完全是 schema 默认值。 */
function isDefaultPluginConfig(cfg) {
  try {
    return JSON.stringify(Config(cfg || {})) === JSON.stringify(Config({}))
  } catch { return false }
}

/** 启动时的兜底：配置被重置成默认值、而备份里有用户配置时，用备份。 */
function restoreConfigIfReset(serverDir, incoming) {
  try {
    if (!incoming || typeof incoming !== 'object') return incoming
    const backup = readConfigBackup(serverDir)
    if (!backup) return incoming
    if (isDefaultPluginConfig(incoming) && !isDefaultPluginConfig(backup)) return backup
  } catch { /* 兜底失败就用传入的 */ }
  return incoming
}

/** 按目录读绑定（模块级版本，给测试和 QQ 门槛复用）。 */
function readBindingsFrom(serverDir) {
  try {
    const raw = readFileSync(join(serverDir || paths.serverDir, 'ops', 'data', 'bindings.json'), 'utf8').replace(/^\uFEFF/, '')
    const doc = JSON.parse(raw)
    return Array.isArray(doc)
      ? doc.map((x) => ({ qq: String((x && x.qq) || ''), name: String((x && x.name) || '') })).filter((x) => x.qq && x.name)
      : []
  } catch { return [] }
}

/**
 * QQ 侧门槛：白名单开启时，未绑定 / 查不到时长 / 时长不足 都不许操作服务器。
 * 返回 { gated, reason: '' | 'unbound' | 'unknown' | 'short', minutes, need, name }
 */
function playtimeGateForQqFor(qq, cfg, serverDir) {
  const c = cfg || {}
  const rawNeed = Number(c.minPlaytimeMinutes); const need = Number.isFinite(rawNeed) ? Math.max(0, rawNeed) : 60
  const result = { gated: false, minutes: null, need, name: '', reason: '' }
  if (c.playtimeGate === false) return result
  if (!whitelistEnabled(serverDir)) return result
  if (readOwnersList(join(serverDir || paths.serverDir, 'ops')).includes(String(qq || ''))) return result
  const names = readBindingsFrom(serverDir).filter((b) => b.qq === qq).map((b) => b.name)
  if (!names.length) { result.gated = true; result.reason = 'unbound'; return result }
  // 免门槛名单里的游戏名：直接放行
  const trusted = Array.isArray(c.trustedPlayers) ? c.trustedPlayers.map((x) => String(x || '').trim().toLowerCase()) : []
  if (trusted.length && names.some((n) => trusted.includes(String(n).toLowerCase()))) return result
  let best = null
  for (const name of names) {
    const minutes = readPlaytimeMinutes(name, serverDir)
    if (minutes === null) continue
    if (best === null || minutes > best) { best = minutes; result.name = name }
  }
  result.minutes = best
  if (best === null) { result.gated = true; result.reason = 'unknown'; return result }
  result.gated = best < need
  result.reason = result.gated ? 'short' : ''
  return result
}

/**
 * 保存配置时的备份策略：如果这次提交的是「全默认值」，而备份里有用户配置，
 * 就不覆盖备份——防止面板显示默认值时误操作把用户配置永久冲掉。
 */
function saveConfigBackupSafe(cfg) {
  try {
    const backup = readConfigBackup(paths.serverDir)
    if (backup && isDefaultPluginConfig(cfg) && !isDefaultPluginConfig(backup)) return
    writeConfigBackup(paths.serverDir, cfg)
  } catch { /* 备份失败不影响保存 */ }
}

/** 读 ops/data/bindings.json：QQ openid 与游戏名的绑定。 */function readPlayerBindings() {
  try {
    const raw = readFileSync(join(paths.serverDir, 'ops', 'data', 'bindings.json'), 'utf8').replace(/^\uFEFF/, '')
    const doc = JSON.parse(raw)
    return Array.isArray(doc)
      ? doc.map((x) => ({ qq: String((x && x.qq) || ''), name: String((x && x.name) || '') })).filter((x) => x.qq && x.name)
      : []
  } catch {
    return []
  }
}

/** 从 mcadmin players 的输出里解析在线玩家名。 */
function parseOnlinePlayers(text) {
  const match = /online:\s*([^\n]*)/i.exec(String(text || ''))
  if (!match) return []
  return match[1].split(',').map((x) => x.trim()).filter(Boolean)
}

// ─────────────────── 时间投票 / 游戏时长 ───────────────────

/** 时间预设：key → { ticks, name }。ticks 直接喂给 /time set。 */
const TIME_PRESETS = {
  day: { ticks: 1000, name: '白天' },
  noon: { ticks: 6000, name: '正午' },
  sunset: { ticks: 12000, name: '日落' },
  night: { ticks: 13000, name: '夜晚' },
  midnight: { ticks: 18000, name: '午夜' },
  sunrise: { ticks: 23000, name: '日出' },
}
const TIME_ALIASES = {
  白天: 'day', 早上: 'day', 天亮了: 'day',
  正午: 'noon', 中午: 'noon',
  日落: 'sunset', 黄昏: 'sunset',
  夜晚: 'night', 晚上: 'night', 天黑: 'night',
  午夜: 'midnight', 半夜: 'midnight',
  日出: 'sunrise', 早上好: 'sunrise',
}

/** 时间参数规范化：预设名 / 中文别名 / 0-24000 的 tick 数。不认识返回 null。 */
function normalizeTimeArg(arg) {
  const raw = String(arg === undefined || arg === null ? '' : arg).trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (TIME_PRESETS[lower]) return { key: lower, ticks: TIME_PRESETS[lower].ticks, name: TIME_PRESETS[lower].name }
  if (TIME_ALIASES[raw]) {
    const key = TIME_ALIASES[raw]
    return { key, ticks: TIME_PRESETS[key].ticks, name: TIME_PRESETS[key].name }
  }
  if (/^\d{1,5}$/.test(raw)) {
    const ticks = Math.max(0, Math.min(24000, Number(raw)))
    return { key: String(ticks), ticks, name: ticks + ' ticks' }
  }
  return null
}

/** 投票用的一句话：去掉换行和颜色码。 */
function sanitizeBroadcast(text) {
  return String(text || '')
    .replace(/§./g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** 读 server.properties 的某个键（键名不区分大小写）。 */
function readServerProperty(key, serverDir) {
  try {
    const file = join(serverDir || paths.serverDir, 'server.properties')
    if (!existsSync(file)) return ''
    const target = String(key || '').toLowerCase()
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([^=#][^=]*)=(.*)$/.exec(line)
      if (m && m[1].trim().toLowerCase() === target) return m[2].trim()
    }
  } catch { /* 读不到当没有 */ }
  return ''
}

/** 服务器是否开着白名单。 */
/** 白名单状态：是否开启 + 名单人数，给设置面板显示用。 */
function readWhitelistState(serverDir) {
  const dir = serverDir || paths.serverDir
  const state = { enabled: whitelistEnabled(dir), count: 0, enforce: false }
  try {
    const file = join(dir, 'whitelist.json')
    if (existsSync(file)) {
      const list = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (Array.isArray(list)) state.count = list.length
    }
  } catch { /* 读不到就当 0 */ }
  try { state.enforce = readServerProperty('enforce-whitelist', dir).toLowerCase() === 'true' } catch { }
  return state
}

function whitelistEnabled(serverDir) {
  return readServerProperty('white-list', serverDir).toLowerCase() === 'true'
}

/** 游戏名 → uuid（usercache.json）。找不到返回空串。 */
function findPlayerUuid(name, serverDir) {
  const dir = serverDir || paths.serverDir
  const target = String(name || '').toLowerCase()
  if (!target) return ''
  // usercache.json 是滚动缓存，只留最近登录的几个人；名字→uuid 必须以 whitelist.json 为准，
  // 否则老玩家/新号查不到 uuid，会被当成「无法判断」直接放行（游戏时长门槛就失效了）。
  for (const file of ['whitelist.json', 'usercache.json', 'ops.json']) {
    try {
      const path = join(dir, file)
      if (!existsSync(path)) continue
      const list = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
      if (!Array.isArray(list)) continue
      const hit = list.find((x) => String((x && x.name) || '').toLowerCase() === target)
      if (hit && hit.uuid) return String(hit.uuid)
    } catch { /* 换下一个来源 */ }
  }
  return ''
}

/**
 * 玩家累计游戏时长（分钟）。读 world/stats/<uuid>.json 里的 play_time（单位是 tick）。
 * 找不到玩家/统计文件时返回 null，表示「无法判断」——调用方应放行，不能误伤。
 */
/** 按 uuid 直接读时长（/mc-ai 请求里就带 uuid，比名字可靠，没绑定的号也能算）。 */
function readPlaytimeByUuid(uuid, serverDir) {
  const id = String(uuid || '').trim()
  if (!id) return null
  const dir = serverDir || paths.serverDir
  const file = join(statsDirOf(dir), id + '.json')
  if (!existsSync(file)) return 0
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const custom = (doc && doc.stats && doc.stats['minecraft:custom']) || {}
    const ticks = Number(custom['minecraft:play_time'] !== undefined ? custom['minecraft:play_time'] : doc['stat.playOneMinute'])
    if (Number.isFinite(ticks) && ticks >= 0) return ticks / 20 / 60
    return 0
  } catch { return null }
}

/** 统计目录：跟随 server.properties 的 level-name（默认 world）。 */
function statsDirOf(serverDir) {
  const dir = serverDir || paths.serverDir
  const level = readServerProperty('level-name', dir) || 'world'
  return join(dir, level, 'stats')
}

function readPlaytimeMinutes(name, serverDir) {
  const dir = serverDir || paths.serverDir
  const uuid = findPlayerUuid(name, dir)
  if (!uuid) return null
  const file = join(statsDirOf(dir), uuid + '.json')
  if (!existsSync(file)) return 0
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const custom = (doc && doc.stats && doc.stats['minecraft:custom']) || {}
    const ticks = Number(custom['minecraft:play_time'] !== undefined ? custom['minecraft:play_time'] : doc['stat.playOneMinute'])
    if (Number.isFinite(ticks) && ticks >= 0) return ticks / 20 / 60
    return 0
  } catch { return null }
}

/** 投票用的同意/反对关键词。 */
const VOTE_YES_RE = /^(同意|赞成|支持|✓|\+1)$/i
const VOTE_NO_RE = /^(反对|拒绝|否决|✗|-1)$/i

/** 天气类型规范化；不认识的返回空串。 */
const WEATHER_NAMES = { clear: '晴天', rain: '下雨', thunder: '雷雨' }
function normalizeWeatherType(arg) {
  const value = String(arg || '').trim().toLowerCase()
  if (value === 'clear' || value === 'sunny' || value === '晴天') return 'clear'
  if (value === 'rain' || value === '下雨') return 'rain'
  if (value === 'thunder' || value === '雷雨') return 'thunder'
  return ''
}

function grantTools(agentId) {
  if (agentId) grants.set(String(agentId), Date.now() + GRANT_MS)
}

function hasToolGrant(agentId) {
  const until = grants.get(String(agentId)) ?? 0
  return until > Date.now()
}

/**
 * 从本机 DSH profile 的 cordis.patch.yml 里读 qqbot 的 AppID / AppSecret。
 * 只在插件设置里没填的时候用；读不到就返回 null，不抛错。
 */
function readQqbotCredentials() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    if (!home) return null
    const dir = join(home, '.dsh', 'profiles')
    if (!existsSync(dir)) return null
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'cordis.patch.yml')
      if (!existsSync(file)) continue
      const raw = readFileSync(file, 'utf8')
      const id = /appId:\s*'?([0-9]+)'?/.exec(raw)
      const sec = /appSecret:\s*'?([A-Za-z0-9_]+)'?/.exec(raw)
      if (id && sec) return { appId: id[1], appSecret: sec[1] }
    }
  } catch { /* 读不到就算了 */ }
  return null
}

const ACTIONS = [
  'status', 'players', 'say', 'cmd', 'start', 'stop', 'restart',
  'logs', 'crashinfo', 'whoami', 'help', 'gamemode', 'weather', 'time',
  'bind-player', 'unbind-player', 'my-players', 'bindings', 'whitelist-sync',
  'kubejs-backup', 'kubejs-reload', 'vote-start', 'vote-approve', 'vote-reject', 'vote-status',
  'export-data', 'import-data', 'bridge-groups',
]

function runMcAdmin(args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.script, '-ServerDir', paths.serverDir, ...args], {
        windowsHide: true,
        cwd: paths.serverDir,
      })
    } catch (error) {
      resolve({ ok: false, text: '无法启动 powershell: ' + (error && error.message ? error.message : String(error)) })
      return
    }
    const chunks = []
    const errChunks = []
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout.on('data', (data) => chunks.push(Buffer.from(data)))
    child.stderr.on('data', (data) => errChunks.push(Buffer.from(data)))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, text: String(error && error.message ? error.message : error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(chunks).toString('utf8').trim()
      const stderr = Buffer.concat(errChunks).toString('utf8').trim()
      if (code === 0) {
        resolve({ ok: true, text: stdout || '(无输出)' })
      } else {
        resolve({ ok: false, text: stderr || stdout || ('退出码 ' + code) })
      }
    })
  })
}

const DESCRIPTION = [
  'Minecraft 服务器的操作入口。',
  '它在宿主进程里直接执行 mcadmin.ps1，不受 shell 沙箱限制、不会触发“允许/拒绝”审批。',
  '',
  'action 取值与权限：',
  '- status：运行状态、在线人数、CPU、内存、TPS、磁盘、运行时长，并带“健康”判定（正常 / 卡顿 / 无响应假死 / 启动中）（任何人可用）',
  '- players：在线玩家名单（任何人）',
  '- say：游戏内广播，arg 为内容，200 字以内、5 秒限流（任何人）',
  '- logs：最近日志，已过滤 RCON 噪音（任何人）',
  '- crashinfo：最近一次崩溃前后 20 行（任何人）',
  '- help / whoami：指令表 / 查自己的身份（任何人）',
  '- start：启动服务器。确认关闭时任何人可用；在线或启动中仅服主；假死时会提示改用 restart',
  '- stop：停服，仅服主',
  '- restart：服务器确认关闭、或健康=无响应（假死）时任何人可用（假死会自动强杀重启）；健康=正常或启动中时仅服主',
  '- gamemode：切换游戏模式，arg 形如 spectator 玩家名。玩家只能切 survival / spectator，且目标必须是自己绑定的游戏名；creative / adventure 和切别人仅服主',
  '- weather：改天气，arg 为 clear / rain / thunder（也可写 晴天 / 下雨 / 雷雨）。所有玩家都能用：自己的游戏名在线时，小铜会用他的游戏名发起——在线 ≤2 人直接生效，≥3 人时游戏内会广播投票（其他玩家 /vote yes）；服主则直接执行。不要因为 cmd 仅服主就拒绝玩家的天气请求',
  '- time：改游戏时间，arg 为 day / noon / sunset / night / midnight / sunrise（也可写 白天 / 中午 / 日落 / 夜晚 / 午夜 / 日出）或 0-24000 的 tick 数。默认在设置里关闭；开启后规则和天气一样：服主直接执行，在线 ≤ 阈值直接生效，人多时在游戏聊天栏发起投票（其他玩家发「同意」/「反对」，发起人自动算 1 票）',
  '- cmd：执行任意后台指令（op/deop/ban/kick/whitelist 等），仅服主',
  '',
  '玩家还能做：用 read / glob / grep 看服务器文件、用只读的 pwsh 命令查信息、用 qqbot_send_file 把普通文件发到群里（口令/密钥类文件除外）、用 weather 改天气。',
  '玩家不能：改文件、删文件、新建文件、执行危险命令、设置创造模式。',
  '- bind-player：把游戏名绑定到当前 QQ（同时加入服务器白名单），arg 为游戏名（1-16 位字母/数字/下划线），一个 QQ 最多 10 个，一个游戏名最多被 3 个 QQ 绑定',
  '- unbind-player：解绑自己的某个游戏名（若该名字已无其它 QQ 绑定，同时移出白名单），arg 为游戏名',
  '- my-players：列出自己绑定的游戏名和在线状态（任何人可用）',
  '- whitelist-sync：把所有绑定名同步进服务器白名单并开启白名单，仅服主',
  '- kubejs-backup：备份 kubejs/server_scripts 到带时间戳的目录（改配方前先跑）',
  '- kubejs-reload：重载 KubeJS 脚本 + 数据包（改完配方后跑，让配方立即生效）',
  '- vote-start：发起“需要更高权限”的确认投票，arg 为要做什么的一句话说明；返回投票编号',
  '- vote-approve：群友投同意票，arg 为投票编号；同一 QQ 只能投一次，满 2 人即通过，通过后本会话获得 10 分钟高权限',
  '- vote-reject：群友投反对票，arg 为投票编号；只要在满 2 票之前有人否决，这个投票立刻作废、不授权，之后再点同意也不算；已经通过的投票再否决无效',
  '- vote-status：查看投票进度（可带编号）',
  '- export-data：把 ops\\data（绑定、投票、服主名单、口令）打成 zip，arg 为目标路径，仅服主',
  '- import-data：从 zip 恢复 ops\\data，arg 为 zip 路径，仅服主',
  '- bridge-groups：列出机器人加入的 QQ 群（群名 + 群 openid），配置群服互通时用来填 groups；QQ 接口列不出来时回退到本地记录/最近捕获的群，仅服主',
  '',
  '玩家可以改服务器目录下除敏感区（ops\\data、world、白名单、eula、jar/exe/dll、密钥）之外的文件：kubejs 配方、config/defaultconfigs 配置、server.properties 等，write/edit 直接放行；改之前先备份，改完按需 reload。',
  '玩家不能改 kubejs 目录以外的任何文件。',
  '- bindings：列出所有 QQ 与游戏名的绑定，仅服主',
  '',
  '判断服务器是否真的活着要看 status 的“健康”字段：进程还在但 RCON 无响应 = 假死，不要当成正常；TPS < 3 = 卡顿。',
  '永远不要只凭“进程存在”就告诉用户服务器没事。',
  '',
  '服主可以用 whoami 确认身份；确认是 owner 后，该会话在 12 小时内可以使用 write / edit / pwsh / read 等 DSH 工具改文件、下载、删除、执行命令。',
  '玩家身份调用 whoami 只会得到 player，不会获得这些权限。',
  '',
  'actor 必填：必须是 QQ 群消息开头 `[昵称 (ID)]` 里的那个 ID，原样传入，不得改写或猜测；',
  '私聊没有该标记时请让对方到群里操作。权限由脚本按 owners.json 校验，玩家传服主 ID 也会被识别行为日志记录。',
].join('\n')

// ── /mc-ai 附件（配套 mod 1.1.0）──
// mod 一次请求最多带 1 个附件；图片只接受这几种 mediaType，大小都按解码后的原始字节算。
const MC_AI_MAX_ATTACHMENTS = 1
const MC_AI_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MC_AI_IMAGE_MAX_BYTES = 8 * 1024 * 1024
const MC_AI_FILE_MAX_BYTES = 16 * 1024 * 1024
const MC_AI_TOTAL_MAX_BYTES = 24 * 1024 * 1024
// 请求体上限：24MB 原始字节编码成 base64 约 32MB，再留 JSON 和字段名的余量。
const MC_AI_MAX_BODY_BYTES = 40 * 1024 * 1024
// 文本类小文件直接内联进消息，不依赖 agent 有没有文件工具；>100KB 或二进制仍走 file 块。
const MC_AI_INLINE_FILE_MAX_BYTES = 100 * 1024
const MC_AI_TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'json5', 'yml', 'yaml', 'toml', 'csv', 'tsv', 'log',
  'java', 'kt', 'kts', 'groovy', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
  'cfg', 'conf', 'config', 'properties', 'ini', 'html', 'htm', 'css', 'scss', 'xml', 'sql',
  'diff', 'patch', 'mcmeta', 'mcfunction', 'snbt',
])

/** Node 的 base64 解码很宽容：必须重新编码和原文一致，才算规范 base64。 */
function decodeCanonicalBase64(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const bytes = Buffer.from(text, 'base64')
  return bytes.toString('base64') === text ? bytes : null
}

/** 文本内容里可打印字符的占比是否够高（二进制文件往往含大量控制字符）。 */
function looksLikeText(text) {
  if (text.length === 0) return false
  let printable = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    if (code === 0x7f) continue
    printable++
  }
  return printable / text.length >= 0.95
}

/**
 * 文件附件能否内联给模型：≤100KB、UTF-8 严格可解码，且（常见文本扩展名 或 可打印比例高）。
 * 返回内联文本；不能内联返回 null（调用方继续走 file 块 + 路径投影）。
 */
function inlineFileText(name, bytes) {
  if (bytes.byteLength > MC_AI_INLINE_FILE_MAX_BYTES) return null
  let text = ''
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  const ext = match ? match[1].toLowerCase() : ''
  // 常见文本扩展名直接内联；其它（比如无扩展名）看内容是不是足够像文本。
  if (MC_AI_TEXT_EXTENSIONS.has(ext)) return text
  return looksLikeText(text) ? text : null
}

/**
 * 校验 /mc-ai 请求里的 attachments。
 * 返回 { ok: true, items: [{ kind, name, mediaType, bytes, inlineText }] } 或 { ok: false, error: '中文原因' }；
 * 坏数据 / 未知类型 / 超限都在这里拒掉，不往上冒异常；inlineText 为 null 表示走 file 块。
 */
function normalizeMcAiAttachments(raw) {
  if (raw === undefined || raw === null) return { ok: true, items: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments 必须是数组' }
  if (raw.length > MC_AI_MAX_ATTACHMENTS) {
    return { ok: false, error: '当前版本一次最多带 ' + MC_AI_MAX_ATTACHMENTS + ' 个附件' }
  }
  const items = []
  let totalBytes = 0
  for (let i = 0; i < raw.length; i++) {
    const att = raw[i]
    const at = '第 ' + (i + 1) + ' 个附件'
    if (!att || typeof att !== 'object') return { ok: false, error: at + '格式不对' }
    const kind = String(att.kind || '')
    if (kind !== 'image' && kind !== 'file') return { ok: false, error: at + '的 kind 只能是 image 或 file' }
    const isImage = kind === 'image'
    const name = String(att.name || (isImage ? 'image.png' : 'file')).slice(0, 255)
    const mediaType = String(att.mediaType || (isImage ? 'image/png' : 'application/octet-stream')).toLowerCase()
    if (isImage && !MC_AI_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      return { ok: false, error: at + '的图片类型不支持：' + mediaType + '（只接受 png / jpeg / webp / gif）' }
    }
    if (typeof att.data !== 'string' || att.data.length === 0) return { ok: false, error: at + '缺少 data（base64）' }
    const maxBytes = isImage ? MC_AI_IMAGE_MAX_BYTES : MC_AI_FILE_MAX_BYTES
    // 先按 base64 字符串长度粗判，避免超限数据白白解码、占一大块内存。
    if (att.data.length > Math.ceil(maxBytes / 3) * 4 + 8) {
      return { ok: false, error: at + '超过大小上限（' + (maxBytes / 1024 / 1024) + 'MB）' }
    }
    const bytes = decodeCanonicalBase64(att.data)
    if (!bytes) return { ok: false, error: at + '的 data 不是规范 base64' }
    if (bytes.byteLength > maxBytes) {
      return { ok: false, error: at + '超过大小上限（' + (maxBytes / 1024 / 1024) + 'MB）' }
    }
    totalBytes += bytes.byteLength
    if (totalBytes > MC_AI_TOTAL_MAX_BYTES) {
      return { ok: false, error: '附件总大小超过 ' + (MC_AI_TOTAL_MAX_BYTES / 1024 / 1024) + 'MB 上限' }
    }
    items.push({ kind, name, mediaType, bytes, inlineText: kind === 'file' ? inlineFileText(name, bytes) : null })
  }
  return { ok: true, items }
}

/** 附件概要，写进 mc-ai.log，例如 [att 1 image/png 230KB]、[att 1 file/application/octet-stream 1KB inline]。 */
function describeMcAiAttachments(items) {
  if (!items.length) return ''
  const kinds = items.map((a) => (a.kind === 'image' ? a.mediaType : 'file/' + a.mediaType))
  const total = items.reduce((sum, a) => sum + a.bytes.byteLength, 0)
  const inline = items.some((a) => a.kind === 'file' && a.inlineText !== null) ? ' inline' : ''
  return '[att ' + items.length + ' ' + kinds.join('+') + ' ' + Math.max(1, Math.round(total / 1024)) + 'KB' + inline + ']'
}

/** 把校验过的附件存进 DSH 的 attachments 存储，返回要追加到 user message 的 content 块。 */
async function storeMcAiAttachment(store, item) {
  if (item.kind === 'image') {
    const refs = await store.saveImages([{ data: item.bytes, mediaType: item.mediaType, name: item.name }])
    return { type: 'image', attachment: refs[0] }
  }
  const ref = await store.saveFile({ data: item.bytes, name: item.name })
  return { type: 'file', attachment: ref }
}

// ── /mc-exchange（AIMCmarket 市场接口，默认关闭）──
// 和小铜的 /mc-ai 共用同一个本地 HTTP 服务；独立会话 + 独立 system prompt，只输出 JSON。
const MC_EXCHANGE_SESSION_PREFIX = 'mc-exchange:'
// 请求体硬上限：context 再大也只缓冲到这里，之后按 maxContextChars 截断。
const MC_EXCHANGE_MAX_BODY_BYTES = 1024 * 1024
const MC_EXCHANGE_LOG_NAME = 'mc-exchange.log'

/** 会话 id → exchange task；不是 exchange 会话返回空串。 */
function exchangeSessionTask(id) {
  const text = String(id || '')
  if (!text.startsWith(MC_EXCHANGE_SESSION_PREFIX)) return ''
  const task = text.slice(MC_EXCHANGE_SESSION_PREFIX.length)
  return EXCHANGE_AGENT_TASKS.includes(task) ? task : ''
}

function shortErrorMessage(error) {
  const message = error && error.message ? error.message : String(error)
  return String(message || '未知错误').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** 日志里的一行错误摘要：压掉换行、限长，避免把整段模型输出写进日志。 */
function clipLogMessage(text, max = 160) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max)
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : fallback
  return Math.max(min, Math.min(max, base))
}

/** 读请求体：超过 maxBytes 就停止缓冲并标记（不把超大 body 拼进内存）。 */
function readCappedBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    let tooBig = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk) => {
      if (tooBig) return
      bytes += chunk.length
      if (bytes > maxBytes) {
        tooBig = true
        chunks.length = 0
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => finish(tooBig ? { tooBig: true } : { text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => finish({ error: '请求读取失败' }))
  })
}

export const name = 'mc-server-ops'
export const inject = ['tools']
// 诊断/测试用：判断某个路径是否落在受保护区域，以及临时改一份受保护清单
export { isProtectedPath, setProtectedPaths }
// 诊断/测试用：版本比较与「查最新版本」
export { compareVersions, checkLatestVersion }
/** 测试/诊断用：直接按「游戏名 + 配置」算门槛状态（不依赖 apply 内的闭包）。 */
/**
 * 这个游戏名是不是绑到了某个服主 QQ 上。
 * 服主不受「绑定 + 游戏时长」限制：他本人玩新号也不该被门槛挡住。
 */
function playerIsOwnerGameName(name, serverDir) {
  try {
    const target = String(name || '').toLowerCase()
    if (!target) return false
    const dir = serverDir || paths.serverDir
    const owners = readOwnersList(join(dir, 'ops'))
    if (!owners.length) return false
    let bindings = null
    try {
      bindings = JSON.parse(readFileSync(join(dir, 'ops', 'data', 'bindings.json'), 'utf8').replace(/^\uFEFF/, ''))
    } catch { return false }
    if (!Array.isArray(bindings)) return false
    return bindings.some((b) => String((b && b.name) || '').toLowerCase() === target
      && owners.includes(String((b && b.qq) || '')))
  } catch { return false }
}

function playtimeGateStateFor(name, cfg, serverDir, uuid) {
  const c = cfg || {}
  const rawNeed = Number(c.minPlaytimeMinutes); const need = Number.isFinite(rawNeed) ? Math.max(0, rawNeed) : 60
  const state = { gated: false, minutes: null, need, name: String(name || '') }
  const byUuid = () => readPlaytimeByUuid(uuid, serverDir)
  if (c.playtimeGate === false) return state
  // 服主豁免：绑定了服主 QQ 的游戏名，或手填进 trustedPlayers 的名字
  if (playerIsOwnerGameName(state.name, serverDir)) return state
  const trusted = Array.isArray(c.trustedPlayers) ? c.trustedPlayers : []
  if (trusted.some((x) => String(x || '').trim().toLowerCase() === state.name.toLowerCase())) return state
  if (!whitelistEnabled(serverDir)) return state
  if (!state.name && !uuid) return state
  // 请求里带了 uuid 就直接按 uuid 读（没绑定的号也能算）；否则按名字查
  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(uuid || ''))
  const minutes = uuidOk ? byUuid() : readPlaytimeMinutes(state.name, serverDir)
  state.minutes = minutes
  if (minutes === null) return state
  state.gated = minutes < need
  return state
}

// 诊断/测试用：自更新用到的两个内部函数
export { runCommand, findProfileDir }
// 诊断/测试用：时间投票 / 游戏时长 / 配置备份
export { normalizeTimeArg, readPlaytimeMinutes, playtimeGateForQqFor, readConfigBackup, writeConfigBackup, restoreConfigIfReset, isDefaultPluginConfig, playtimeGateStateFor, whitelistEnabled, playerIsOwnerGameName }

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
// 跨平台的只读动作：Windows 上走 PowerShell（信息更全），其它平台走 Node 核心
const NODE_RUNNER = join(SCRIPT_DIR, 'ops', 'rcon.mjs')
const NODE_ACTIONS = new Set(['status', 'players', 'say', 'cmd', 'logs', 'start', 'stop', 'restart'])

/** 插件配置：会完整渲染进 DSH 设置界面。 */
export const Config = Schema.object({
  server: Schema.object({
    dir: Schema.string().default('').description('Minecraft 服务器目录（含 server.properties、mods、java 子目录）。留空则用环境变量 MC_SERVER_DIR，再不行用 D:\\server'),
    rconPort: Schema.number().default(25575).description('RCON 端口（需在 server.properties 里开启 enable-rcon）'),
    rconPassword: Schema.string().default('').description('RCON 密码；留空则从 server.properties 读取'),
  }).description('服务器'),

  persona: Schema.object({
    enabled: Schema.boolean().default(true).description('是否把下面的人设注入 QQ 会话'),
    name: Schema.string().default('小铜').description('助手在群里的名字'),
    text: Schema.string().default('').description('人设正文。留空使用内置默认（小铜）。改名字/口吻都改这里，不用改代码'),
    scope: Schema.union(['qq', 'all', 'none']).default('qq').description('注入范围：qq=只注入 QQ 群/私聊；all=所有会话；none=关闭'),
  }).description('人设'),

  ops: Schema.object({
    allowPlayerWrite: Schema.boolean().default(true).description('允许玩家改服务器目录下除敏感区（ops\\data、world、白名单、jar/exe/dll）之外的文件'),
    grantHours: Schema.number().default(12).description('服主确认后，该会话可编辑文件/执行命令的有效时长（小时）'),
    riskApprovalSeconds: Schema.number().default(30).description('创建服主口令的冷却（秒），防止被刷'),
  }).description('权限'),

  permissions: Schema.object({
    voteEscalation: Schema.boolean().default(true).description('允许群友投票放权（改 world / ops\\data / 白名单）。关掉后只有服主能改'),
    kubejsEdit: Schema.boolean().default(true).description('允许玩家改 KubeJS 配方脚本（kubejs/ 目录）'),
    configEdit: Schema.boolean().default(true).description('允许玩家改 config / defaultconfigs / server.properties'),
    playerStart: Schema.boolean().default(true).description('服务器关闭时，玩家可以用 start 开服'),
    playerRestart: Schema.boolean().default(true).description('服务器崩溃或假死时，玩家可以 restart'),
    playerStop: Schema.boolean().default(false).description('允许玩家停服（默认关闭，只有服主能停）'),
    gamemodeSwitch: Schema.boolean().default(true).description('允许玩家把自己在生存 / 旁观之间切换'),
    say: Schema.boolean().default(true).description('允许玩家用 say 在游戏里广播'),
    fileSend: Schema.boolean().default(true).description('允许玩家把普通文件发到群里'),
  }).description('功能开关'),

  vote: Schema.object({
    approveNeed: Schema.number().min(1).default(2).description('通过需要多少位群友同意'),
    rejectNeed: Schema.number().min(1).default(1).description('多少位群友反对就作废（1 = 一票否决）'),
    timeoutMinutes: Schema.number().min(1).default(15).description('投票多少分钟没凑够门槛就自动作废'),
    vetoEnabled: Schema.boolean().default(true).description('允许一票否决：凑够同意票之前有人反对就作废。关掉后反对票只记录、不作废'),
    protectedPaths: Schema.array(Schema.string()).default(['world', 'ops/data', 'whitelist'])
      .description('受保护路径：改动这些位置需要群友投票放行。默认 world, ops/data, whitelist'),
  }).description('投票'),

  weather: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('允许游戏内玩家用 /weather 改天气（需要 mcai mod 1.2.0+）。配置会写到服务器 config/mcai-weather.json，改完即时生效'),
    directThreshold: Schema.number().min(0).max(20).default(2)
      .description('在线玩家不超过这个数时直接改天气、不投票（默认 2：0-2 人直接生效）'),
    approveNeed: Schema.number().min(1).max(20).default(2)
      .description('投票通过需要几人同意（发起人自动算 1 票；默认 2）'),
    rejectNeed: Schema.number().min(1).max(20).default(1)
      .description('几人反对就作废（默认 1 = 一票否决）'),
    timeoutSeconds: Schema.number().min(5).max(3600).default(60)
      .description('投票有效期（秒，默认 60）'),
    cooldownSeconds: Schema.number().min(0).max(86400).default(60)
      .description('同一玩家两次发起的最小间隔（秒，默认 60，0 = 不限）'),
  }).description('游戏内天气投票（配套 mcai mod）'),

  time: Schema.object({
    enabled: Schema.boolean().default(false)
      .description('允许玩家投票改游戏时间（默认关闭，插件自己实现，不需要 mod）。玩家在游戏里说「改成白天」或群里要求时：在线人少直接改，人多在游戏聊天栏投票'),
    directThreshold: Schema.number().min(0).max(20).default(2)
      .description('在线玩家不超过这个数时直接改时间、不投票（默认 2：0-2 人直接生效）'),
    approveNeed: Schema.number().min(1).max(20).default(2)
      .description('投票通过需要几人同意（发起人自动算 1 票；默认 2）'),
    rejectNeed: Schema.number().min(1).max(20).default(1)
      .description('几人反对就作废（默认 1 = 一票否决）'),
    timeoutSeconds: Schema.number().min(5).max(3600).default(60)
      .description('投票有效期（秒，默认 60）'),
    cooldownSeconds: Schema.number().min(0).max(86400).default(60)
      .description('同一玩家两次发起的最小间隔（秒，默认 60，0 = 不限）'),
  }).description('游戏内时间投票（插件自己实现）'),

  adapter: Schema.union(['local', 'panel']).default('local')
    .description('写操作走哪条路：local=本机直接跑脚本（默认）；panel=通过 Pterodactyl 面板的 HTTP API 启停/发指令'),
  panel: Schema.object({
    url: Schema.string().default('').description('面板地址，例如 https://panel.example.com（不要带结尾斜杠）'),
    serverId: Schema.string().default('').description('服务器 ID：面板里该服务器 URL 的最后一段（8 位短 UUID）'),
    clientApiKey: Schema.string().default('').description('客户端 API Key（ptlc_ 开头，面板 → Account → API Credentials 里生成）'),
  }).description('Pterodactyl 面板（adapter 选 panel 时才用）'),

  bridge: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('群服互通：把游戏内聊天直接转发到 QQ 群。不经过 AI，不消耗 token'),
    mode: Schema.union(['auto', 'on', 'off']).default('auto')
      .description('auto=有玩家在线才转发（默认）；on=常开；off=常关'),
    groups: Schema.array(Schema.string()).default([])
      .description('转发到哪些群（群 openid）。用 mc_server 的 bridge-groups 可以查机器人加入的群'),
    appId: Schema.string().default('').description('QQ 机器人 AppID；留空自动从本机 qqbot 插件配置里读'),
    appSecret: Schema.string().default('').description('QQ 机器人 AppSecret；留空自动读'),
    events: Schema.object({
      join: Schema.boolean().default(false).description('转发玩家加入（默认关，容易刷屏）'),
      leave: Schema.boolean().default(false).description('转发玩家离开（默认关，容易刷屏）'),
      death: Schema.boolean().default(false).description('转发死亡消息（默认关）'),
    }).description('除聊天外还要转发哪些事件'),
    coalesceMs: Schema.number().default(3000)
      .description('固定合并窗口（毫秒）；合并模式选「固定」时用这个值'),
    coalesce: Schema.object({
      mode: Schema.union(['auto', 'fixed']).default('auto')
        .description('合并窗口：auto=按最近发言节奏和在线人数自动调整（默认）；fixed=固定用 coalesceMs'),
      minMs: Schema.number().default(1000).description('自动模式最短等待（毫秒），冷场时用'),
      maxMs: Schema.number().default(60000).description('自动模式最长等待（毫秒），最多攒这么久就发'),
      sampleSize: Schema.number().default(3).description('参考最近几条发言算节奏（2-6）'),
      quietMs: Schema.number().default(60000).description('超过这么久没说话就算冷场（毫秒）'),
      fullPlayers: Schema.number().default(2).description('在线人数达到这个值算满档'),
      fastMs: Schema.number().default(50000).description('相邻两条发言间隔小于这个值算满活跃（毫秒）'),
    }).description('合并窗口自动调整：人少话稀就快发，人多话密就多攒一会儿'),
    maxPerDay: Schema.number().default(900).description('每个群每天最多发几条（官方上限 1000，留余量）'),
  }).description('群服互通'),

  ai: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('允许游戏内玩家用 /ai 和小铜对话（需要配套的 Forge mod；只监听 127.0.0.1）'),
    port: Schema.number().default(8765).description('mod 连接的端口，默认 8765'),
    timeoutSeconds: Schema.number().default(60).description('等待 AI 回复的超时时间（秒）'),
    playtimeGate: Schema.boolean().default(true)
      .description('白名单开启时，已绑定游戏账号但游戏时长不足门槛的玩家，禁止让小铜执行服务器操作（聊天不受影响）。默认开启'),
    minPlaytimeMinutes: Schema.number().min(0).max(100000).default(60)
      .description('游戏时长门槛（分钟，默认 60）'),
    trustedPlayers: Schema.array(Schema.string()).default([])
      .description('免门槛的游戏名（服主自己的号，一行一个）。填进来的名字不看绑定、不看游戏时长，和绑定了服主 QQ 的号一样'),
  }).description('游戏内 AI 对话'),

  exchange: Schema.object({
    enabled: Schema.boolean().default(false)
      .description('AI 市场接口（AIMCmarket）。默认关闭；开启后 AIMCmarket 模组可使用 /mc-exchange 做结构化解析/新闻/财报/招股书/政府政策，其它功能不受影响。关掉时该路由返回 404，不建会话、不消耗 token'),
    timeoutSeconds: Schema.number().min(1).max(300).default(20)
      .description('单次 /mc-exchange 等待模型输出的超时（秒，默认 20）'),
    maxPerMinute: Schema.number().min(1).max(600).default(30)
      .description('全局限流：每分钟最多处理多少个 /mc-exchange 请求，超了返回 429（默认 30）'),
    maxContextChars: Schema.number().min(100).max(200000).default(20000)
      .description('请求 context 序列化后的最大字符数，超了截断（默认 20000）'),
  }).description('AI 市场接口（AIMCmarket）'),
})

// ─────────────────────── 检查更新 / 自更新 ───────────────────────

const PKG_NAME = 'dsh-mc-server-ops'
const GH_REPO = 'mogutofu/dsh-mc-server-ops'
const NPM_LATEST_URL = 'https://registry.npmjs.org/' + PKG_NAME + '/latest'
const GH_LATEST_URL = 'https://api.github.com/repos/' + GH_REPO + '/releases/latest'

function homeDir() { return process.env.USERPROFILE || process.env.HOME || '' }

/** 当前安装的版本（读包内 package.json）。 */
function localVersion() {
  try {
    return String(JSON.parse(readFileSync(join(SCRIPT_DIR, 'package.json'), 'utf8')).version || '')
  } catch { return '' }
}

/** 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0。只处理 x.y.z[-pre]。 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null
  }
  const pa = parse(a), pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.n[i] !== pb.n[i]) return pa.n[i] > pb.n[i] ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre > pb.pre ? 1 : -1
}

async function fetchJson(url, ms = 8000) {
  const res = await fetch(url, {
    headers: { 'user-agent': PKG_NAME, accept: 'application/json' },
    signal: AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined,
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** 依次问 npm / GitHub，返回最新版本。npm 优先。 */
async function checkLatestVersion() {
  const current = localVersion()
  const errors = []
  let latest = ''
  let source = ''
  try {
    const doc = await fetchJson(NPM_LATEST_URL)
    latest = String(doc.version || '')
    if (latest) source = 'npm'
  } catch (error) {
    errors.push('npm ' + (error && error.message ? error.message : String(error)))
  }
  if (!latest) {
    try {
      const doc = await fetchJson(GH_LATEST_URL)
      latest = String(doc.tag_name || '').replace(/^v/i, '')
      if (latest) source = 'github'
    } catch (error) {
      errors.push('github ' + (error && error.message ? error.message : String(error)))
    }
  }
  return {
    current,
    latest,
    source,
    hasUpdate: !!latest && compareVersions(latest, current) > 0,
    error: latest ? '' : ('检查失败：' + errors.join('；')),
  }
}

/** 找到装着本插件的 profile 目录。 */
function findProfileDir() {
  const self = SCRIPT_DIR.replace(/\\/g, '/')
  const m = /\/profiles\/([^/]+)\/node_modules\//.exec(self)
  const home = homeDir()
  if (m && home) return { name: m[1], dir: join(home, '.dsh', 'profiles', m[1]) }
  const root = home ? join(home, '.dsh', 'profiles') : ''
  if (!root || !existsSync(root)) return null
  try {
    for (const name of readdirSync(root)) {
      const file = join(root, name, 'cordis.patch.yml')
      if (!existsSync(file)) continue
      if (readFileSync(file, 'utf8').includes(PKG_NAME)) return { name, dir: join(root, name) }
    }
  } catch { /* 扫不动就算了 */ }
  return null
}

function findDshCli() {
  const dir = dirname(process.execPath)
  const candidates = [
    join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh'),
  ]
  return candidates.find((p) => existsSync(p)) || ''
}

function findPnpmRunner() {
  const dir = dirname(process.execPath)
  const home = homeDir()
  const candidates = [
    join(dir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  return candidates.find((p) => existsSync(p)) || ''
}

function quoteWinArg(value) {
  const s = String(value)
  return /[\s"&|<>^]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s
}

function runCommand(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      if (/\.(cmd|bat)$/i.test(file)) {
        // cmd.exe 会把整条命令重新解析一遍：路径里有空格（Program Files）时必须自己加引号，
        // 否则它会把 "C:\Program" 当成命令。
        const line = [quoteWinArg(file), ...args.map(quoteWinArg)].join(' ')
        child = spawn('cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], {
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      } else {
        child = spawn(file, args, { windowsHide: true })
      }
    } catch (error) {
      resolve({ ok: false, text: String(error && error.message ? error.message : error) })
      return
    }
    const out = []
    const err = []
    const timer = setTimeout(() => { try { child.kill() } catch { } }, timeoutMs)
    child.stdout.on('data', (d) => out.push(Buffer.from(d)))
    child.stderr.on('data', (d) => err.push(Buffer.from(d)))
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: String(e && e.message ? e.message : e) }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = (Buffer.concat(err).toString('utf8') + '\n' + Buffer.concat(out).toString('utf8')).trim()
      resolve({ ok: code === 0, text: text.slice(-600) })
    })
  })
}

/**
 * 执行更新：先 npm，失败再 GitHub 的 tag tarball。
 * 本机是 link: 安装（开发模式）时不动，避免把链接换掉。
 */
async function performUpdate(targetVersion) {
  const version = String(targetVersion || '').trim()
  if (!version) return { ok: false, text: '没有可用的版本号，请先点「检查更新」。' }
  const profile = findProfileDir()
  if (!profile) return { ok: false, text: '找不到安装目录，请手动更新。' }
  try {
    const target = join(profile.dir, 'node_modules', PKG_NAME)
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      return { ok: false, text: '当前是本地链接安装（开发模式），自动更新会断开链接，请手动更新。' }
    }
  } catch { /* 判断不了就继续尝试 */ }

  const attempts = [
    { label: 'npm', spec: PKG_NAME + '@' + version },
    { label: 'github', spec: 'https://codeload.github.com/' + GH_REPO + '/tar.gz/refs/tags/v' + version },
  ]
  const cli = findDshCli()
  const pnpm = findPnpmRunner()
  if (!cli && !pnpm) return { ok: false, text: '找不到 DSH 自带的包管理器，请手动更新。' }

  let lastError = ''
  for (const attempt of attempts) {
    const result = cli
      ? await runCommand(cli, ['plugin', '--profile', profile.name, 'add', attempt.spec], 240000)
      : await runCommand(process.execPath, ['--expose-internals', pnpm, 'add', attempt.spec, '--dir', profile.dir], 240000)
    if (result.ok) {
      return { ok: true, text: '已更新到 ' + version + '（来源 ' + attempt.label + '），重启 DSH 生效。' }
    }
    lastError = attempt.label + ': ' + String(result.text || '').replace(/\s+/g, ' ').slice(0, 160)
  }
  return { ok: false, text: '下载失败，请手动更新。（' + lastError + '）' }
}

/** /mc-ops/update：GET 检查版本，POST 执行更新。 */
async function handleUpdateRoute(req, res) {
  const send = (code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    } catch { }
  }
  if (String(req.headers['x-mc-ops-client'] || '') !== '1') return send(403, { error: '只接受来自设置面板的请求' })
  if (req.method === 'GET') {
    try { return send(200, await checkLatestVersion()) }
    catch (error) { return send(500, { error: String(error && error.message ? error.message : error) }) }
  }
  if (req.method !== 'POST') return send(405, { error: '只支持 GET / POST' })
  const body = await readJsonBody(req)
  if (!body) return send(400, { error: '请求体不是合法 JSON' })
  const result = await performUpdate(body.version)
  return send(result.ok ? 200 : 500, result)
}

export function apply(ctx, config) {
  // 配置兜底：更新插件后若配置行被重置成默认值，用 ops/data/config-backup.json 顶回去。
  {
    const preServer = String(((config && config.server) || {}).dir || process.env.MC_SERVER_DIR || 'D:\\server').replace(/[\\/]+$/, '')
    config = restoreConfigIfReset(preServer, config)
    writeConfigBackup(preServer, config)
  }
  const perms = Object.assign({
    voteEscalation: true,
    kubejsEdit: true,
    configEdit: true,
    playerStart: true,
    playerRestart: true,
    playerStop: false,
    gamemodeSwitch: true,
    say: true,
    fileSend: true,
  }, (config && config.permissions) || {})
  const cfgServer = (config && config.server) || {}
  const serverDir = String(cfgServer.dir || process.env.MC_SERVER_DIR || 'D:\\server').replace(/[\\/]+$/, '')
  paths.serverDir = serverDir
  const opsDir = join(serverDir, 'ops')
  const bundledDir = join(SCRIPT_DIR, 'ops')
  const bundled = join(bundledDir, 'mcadmin.ps1')
  const installed = join(opsDir, 'mcadmin.ps1')
  // 旧版脚本没有 -ServerDir 参数：把包内脚本补/升级到服务器目录，保证参数一致。
  ensureOpsScripts(bundledDir, opsDir)
  paths.script = existsSync(installed) ? installed : bundled
  paths.ownersFile = join(opsDir, 'data', 'owners.json')
  paths.flipLog = join(opsDir, 'data', 'preset-flip.log')

  // ── QQ 群 openid 自动发现 ──
  // 给 qqbot 的 inbound.js 打幂等钩子：它收到群消息时把群 openid 追加到下面的文件，
  // bridge 发现配置里没有群时会自动采用（来源：captured）。首次装插件不需要手填 openid，
  // 群友在群里 @ 一次机器人即可。钩子写失败不影响任何功能，退回手动配置。
  process.env.MC_OPS_QQ_KEYS_FILE = join(opsDir, 'data', 'qq-keys.txt')
  try {
    mkdirSync(join(opsDir, 'data'), { recursive: true })
    ensureQqbotInboundHook({
      log: (m) => {
        try {
          appendFileSync(join(opsDir, 'data', 'bridge.log'), new Date().toISOString() + ' [bridge] ' + m + '\n')
        } catch (error) { }
      },
    })
  } catch (error) { }


  // 设置页：插件详情里渲染自己的表单（client.js），表单通过下面这两个 HTTP 路由读写配置。
  const settingsService = ctx.get('settings')
  if (settingsService && typeof settingsService.configure === 'function') {
    ctx.effect(() => settingsService.configure({ auto: true }))
  }
  // 诊断：等服务起来后把客户端模块图落盘，确认本包的 client 半屏有没有被加载。
  setTimeout(() => {
    const out = join(paths.serverDir, 'ops', 'data', 'client-graph.json')
    const payload = { at: new Date().toISOString(), error: null, entryCount: 0, mine: [], sample: [] }
    try {
      const cm = ctx.get('clientModules')
      if (!cm || typeof cm.graph !== 'function') payload.error = 'no clientModules service'
      else {
        const graph = cm.graph()
        payload.entryCount = (graph.entries || []).length
        payload.mine = (graph.entries || []).filter((e) => JSON.stringify(e).includes('mc-server-ops'))
        payload.sample = (graph.entries || []).filter((e) => JSON.stringify(e).includes('qqbot'))
      }
    } catch (error) {
      payload.error = String(error && error.message ? error.message : error)
    }
    try {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) { }
  }, 8000)
  // 面板读写用：内存里存一份当前配置，作为 settings/configEditor 都不可用时的兜底。
  let liveConfig = {
    server: Object.assign({ rconPort: 25575, rconPassword: '' }, (config && config.server) || {}, { dir: serverDir }),
    persona: Object.assign({ enabled: true, name: '小铜', text: '', scope: 'qq' }, (config && config.persona) || {}),
    ops: Object.assign({ allowPlayerWrite: true, grantHours: 12, riskApprovalSeconds: 30 }, (config && config.ops) || {}),
    adapter: String((config && config.adapter) || 'local'),
    panel: Object.assign({ url: '', serverId: '', clientApiKey: '' }, (config && config.panel) || {}),
    bridge: Object.assign({
      enabled: false, mode: 'auto', groups: [], appId: '', appSecret: '',
      events: { join: false, leave: false, death: true }, coalesceMs: 3000,
      coalesce: {
        mode: 'auto', minMs: 1000, maxMs: 6000, sampleSize: 3,
        quietMs: 20000, fullPlayers: 6, fastMs: 2000,
      },
      maxPerDay: 900,
    }, (config && config.bridge) || {}),
    ai: Object.assign({ enabled: true, port: 8765, timeoutSeconds: 60, playtimeGate: true, minPlaytimeMinutes: 60, trustedPlayers: [] }, (config && config.ai) || {}),
    permissions: Object.assign({}, perms),
    vote: Object.assign({ approveNeed: 2, rejectNeed: 1, timeoutMinutes: 15, vetoEnabled: true, protectedPaths: DEFAULT_PROTECTED.slice() }, (config && config.vote) || {}),
    exchange: Object.assign({
      enabled: false, timeoutSeconds: 20, maxPerMinute: 30, maxContextChars: 20000,
    }, (config && config.exchange) || {}),
    weather: Object.assign({
      enabled: true, directThreshold: 2, approveNeed: 2, rejectNeed: 1,
      timeoutSeconds: 60, cooldownSeconds: 60,
    }, (config && config.weather) || {}),
    time: Object.assign({
      enabled: false, directThreshold: 2, approveNeed: 2, rejectNeed: 1,
      timeoutSeconds: 60, cooldownSeconds: 60,
    }, (config && config.time) || {}),
  }
  // 启动时先把天气投票配置写到服务器 config/mcai-weather.json；mod 每次 /weather 都读这个文件。
  writeWeatherConfig(serverDir, liveConfig.weather)
  const memoryConfig = {
    get: () => liveConfig,
    set: (next) => {
      liveConfig = Object.assign({}, liveConfig, next && typeof next === 'object' ? next : {})
      writeVoteConfig(opsDir, liveConfig.vote)
      setProtectedPaths(liveConfig.vote && liveConfig.vote.protectedPaths)
      writeWeatherConfig(paths.serverDir, liveConfig.weather)
    },
  }
  // 启动时先落一份，保证脚本读到的是当前设置
  writeVoteConfig(opsDir, (config && config.vote) || null)
  setProtectedPaths(config && config.vote && config.vote.protectedPaths)
  // 面板上刚保存的开关要立刻生效，所以每次都合并一次 liveConfig，而不是只用启动时读到的值。
  const currentPerms = () => Object.assign({}, perms, (liveConfig && liveConfig.permissions) || {})
  // /mc-exchange 的配置每次请求现读，面板里改完立刻生效（默认关闭）。
  const currentExchangeConfig = () => Object.assign({
    enabled: false, timeoutSeconds: 20, maxPerMinute: 30, maxContextChars: 20000,
  }, (liveConfig && liveConfig.exchange) || {})
  // 写操作统一走适配器：local 包装 mcadmin.ps1 / rcon.mjs，panel 打 Pterodactyl 的 HTTP API。
  // 每次调用时按当前配置现建一个，面板里改完地址不用重启。
  const ADAPTER_ACTIONS = new Set(['start', 'stop', 'restart', 'cmd'])
  const currentAdapter = () => createAdapter(liveConfig && liveConfig.adapter, {
    runMcAdmin,
    runNodeOps,
    isWindows: process.platform === 'win32',
    nodeActions: NODE_ACTIONS,
    panel: (liveConfig && liveConfig.panel) || {},
  })

  // ── 群服互通的目标群：配置 → 上次记住 → 本地捕获（qq-keys.txt）三层兜底 ──
  // 插件配置存在 profile 的 cordis.patch.yml 里；重装/升级插件时 DSH 会重建这条配置行，
  // 用户填的 bridge.groups 会丢。群 openid 本身可以本地记住，所以这里做持久化 + 自动恢复，
  // 避免「重装一次插件，群服互通就哑了」。
  const BRIDGE_GROUPS_FILE = join(opsDir, 'data', 'bridge-groups.json')
  function readBridgeGroupList(list) {
    return Array.isArray(list) ? list.map((x) => String(x || '').trim()).filter(Boolean) : []
  }
  function rememberBridgeGroups(groups) {
    const list = [...new Set(readBridgeGroupList(groups))]
    if (!list.length) return
    try {
      mkdirSync(join(opsDir, 'data'), { recursive: true })
      writeFileSync(BRIDGE_GROUPS_FILE, JSON.stringify({ at: new Date().toISOString(), groups: list }, null, 2) + '\n', 'utf8')
    } catch (error) { }
  }
  function loadRememberedBridgeGroups() {
    try {
      const doc = JSON.parse(readFileSync(BRIDGE_GROUPS_FILE, 'utf8'))
      return readBridgeGroupList(Array.isArray(doc) ? doc : doc && doc.groups)
    } catch (error) { return [] }
  }
  function loadCapturedBridgeGroups(limit = 3) {
    // qqbot 的 inbound.js 抓到群消息时会把 openid 记进 ops/data/qq-keys.txt（每行「时间 group OPENID」）
    try {
      const text = readFileSync(join(opsDir, 'data', 'qq-keys.txt'), 'utf8')
      const seen = []
      for (const line of text.split(/\r?\n/)) {
        const match = /\bgroup\s+([0-9A-Za-z]{16,64})\b/.exec(line)
        if (!match) continue
        const openid = match[1]
        const index = seen.indexOf(openid)
        if (index !== -1) seen.splice(index, 1)
        seen.push(openid)
      }
      return seen.slice(-limit).reverse()
    } catch (error) { return [] }
  }
  let bridgeGroupsState = { groups: [], source: 'none' }
  let lastBridgeGroupsLog = ''
  function resolveBridgeGroups(rawBridge) {
    const configured = readBridgeGroupList(rawBridge && rawBridge.groups)
    if (configured.length) {
      rememberBridgeGroups(configured)
      bridgeGroupsState = { groups: configured, source: 'config' }
    } else {
      const remembered = loadRememberedBridgeGroups()
      if (remembered.length) {
        bridgeGroupsState = { groups: remembered, source: 'remembered' }
      } else {
        const captured = loadCapturedBridgeGroups()
        if (captured.length) {
          rememberBridgeGroups(captured)
          bridgeGroupsState = { groups: captured, source: 'captured' }
        } else {
          bridgeGroupsState = { groups: [], source: 'none' }
        }
      }
    }
    const key = bridgeGroupsState.source + ':' + bridgeGroupsState.groups.join(',')
    if (key !== lastBridgeGroupsLog) {
      lastBridgeGroupsLog = key
      try {
        const hint = bridgeGroupsState.source === 'none' ? '；未发现目标群：在 QQ 群里 @ 一次机器人即可自动发现，也可在设置里手填' : ''
        appendFileSync(join(opsDir, 'data', 'bridge.log'), new Date().toISOString() + ' [bridge] 群目标：' + (bridgeGroupsState.groups.join(', ') || '（空）') + '（来源：' + bridgeGroupsState.source + '）' + hint + '\n')
      } catch (error) { }
    }
    return bridgeGroupsState
  }

  // ── 群服互通：游戏聊天 → QQ 群（不经过 AI，不产生 token）──
  // 常驻创建、常驻运行：是否真的转发由 liveConfig.bridge.enabled 决定，
  // 这样在面板里打开开关立刻生效，不用再重启一次。
  let bridge = null
  {
    const auto = readQqbotCredentials()
    const appId = String(liveConfig.bridge.appId || (auto && auto.appId) || '')
    const appSecret = String(liveConfig.bridge.appSecret || (auto && auto.appSecret) || '')
    bridge = createBridge({
      serverDir,
      appId,
      appSecret,
      readConfig: () => {
        const raw = (liveConfig && liveConfig.bridge) || {}
        const resolved = resolveBridgeGroups(raw)
        return Object.assign({}, raw, { groups: resolved.groups, groupsSource: resolved.source })
      },
      log: (m) => {
        try { appendFileSync(join(opsDir, 'data', 'bridge.log'), new Date().toISOString() + ' ' + m + '\n') } catch { }
      },
    })
    ctx.effect(() => {
      resolveBridgeGroups((liveConfig && liveConfig.bridge) || {})
      void bridge.start()
      const tick = setInterval(() => {
        resolveBridgeGroups((liveConfig && liveConfig.bridge) || {})
        writeWeatherConfig(serverDir, liveConfig.weather)
        writeBridgeState(serverDir, Object.assign(
          { appId: appId ? appId.slice(0, 3) + '***' : '', hasSecret: !!appSecret },
          bridge.status(),
          { groups: bridgeGroupsState.groups, groupsSource: bridgeGroupsState.source },
        ))
      }, 10000)
      if (tick.unref) tick.unref()
      return () => { clearInterval(tick); bridge.stop() }
    })
  }

  // ── 游戏内时间投票（插件自己实现，不需要 mod）──
  // 玩家要求改时间：在线人少直接改；人多就在游戏聊天栏发起投票，玩家发「同意 / 反对」。
  // 复用 qq-bridge 的日志增量读取来听聊天（不依赖群服互通开关）。
  const timeState = { vote: null }
  const timeCooldown = new Map()

  const broadcastInGame = async (text) => {
    const msg = sanitizeBroadcast(text)
    if (!msg) return { ok: false, text: '空消息' }
    return runMcAdmin(['-Action', 'cmd', '-Arg', 'say ' + msg, '-Actor', 'LOCAL-CONSOLE', '-Channel', 'console'], 60000)
  }

  const applyTimeTarget = async (target) => runMcAdmin(
    ['-Action', 'cmd', '-Arg', 'time set ' + target.key, '-Actor', 'LOCAL-CONSOLE', '-Channel', 'console'],
    60000,
  )

  const clearTimeVote = () => {
    if (!timeState.vote) return
    try { clearTimeout(timeState.vote.timer) } catch { }
    timeState.vote = null
  }

  const settleTimeVote = async (outcome) => {
    const vote = timeState.vote
    if (!vote) return
    clearTimeVote()
    if (vote.by) timeCooldown.set(vote.by, Date.now())
    if (outcome === 'passed') {
      const done = await applyTimeTarget(vote.target)
      await broadcastInGame(done.ok
        ? '【投票通过】时间已改成「' + vote.target.name + '」。'
        : '【投票通过】但改时间失败：' + String(done.text || '').slice(0, 60))
      return
    }
    const why = outcome === 'rejected' ? '被否决' : '超时作废'
    await broadcastInGame('【投票' + why + '】把时间改成「' + vote.target.name + '」的提案没有通过。')
  }

  const startTimeVote = async ({ target, by, initiatorName }) => {
    if (timeState.vote) {
      return {
        ok: false,
        text: '现在已经有时间投票在进行（改成「' + timeState.vote.target.name + '」），等它结束再来。',
      }
    }
    const cfg = (liveConfig && liveConfig.time) || {}
    const need = Math.max(1, Number(cfg.approveNeed) || 2)
    const rejectNeed = Math.max(1, Number(cfg.rejectNeed) || 1)
    const timeout = Math.max(5, Number(cfg.timeoutSeconds) || 60)
    const approve = new Set()
    if (initiatorName) approve.add(String(initiatorName).toLowerCase())
    const id = 'T' + String(Date.now()).slice(-5)
    const vote = { id, target, by, approve, reject: new Set(), need, rejectNeed, timer: null }
    vote.timer = setTimeout(() => { void settleTimeVote('expired') }, timeout * 1000)
    if (vote.timer.unref) vote.timer.unref()
    timeState.vote = vote
    const sent = await broadcastInGame('【投票 ' + id + '】把时间改成「' + target.name + '」（发起人 '
      + (initiatorName || by || '玩家') + '）。' + timeout + ' 秒内在聊天栏发「同意」或「反对」，需要 '
      + need + ' 人同意。')
    if (!sent.ok) {
      clearTimeVote()
      return { ok: false, text: '发起投票失败（游戏内广播发不出去）：' + String(sent.text || '').slice(0, 80) }
    }
    // approveNeed 可能被设成 1：发起人这一票就够了，立刻结算
    if (approve.size >= need) { void settleTimeVote('passed') }
    return {
      ok: true,
      text: '已在游戏里发起投票（编号 ' + id + '）：把时间改成「' + target.name + '」。'
        + '其他玩家在聊天栏发「同意」即可，还差 ' + Math.max(0, need - approve.size) + ' 票；'
        + '有人发「反对」会立刻作废。' + timeout + ' 秒内没凑够就自动过期。',
    }
  }

  const handleTimeVoteChat = (evt) => {
    const cfg = (liveConfig && liveConfig.time) || {}
    if (cfg.enabled !== true) return
    const vote = timeState.vote
    if (!vote || !evt || evt.type !== 'chat') return
    const text = String(evt.text || '').trim().replace(/[，。！？!?,.~\s]+$/g, '')
    const player = String(evt.player || '')
    if (!player) return
    const yes = VOTE_YES_RE.test(text)
    const no = VOTE_NO_RE.test(text)
    if (!yes && !no) return
    const who = player.toLowerCase()
    if (yes) {
      if (vote.reject.has(who) || vote.approve.has(who)) return
      vote.approve.add(who)
      if (vote.approve.size >= vote.need) { void settleTimeVote('passed'); return }
      void broadcastInGame('【投票 ' + vote.id + '】' + player + ' 同意（' + vote.approve.size + '/' + vote.need + '）。')
      return
    }
    if (vote.approve.has(who) || vote.reject.has(who)) return
    vote.reject.add(who)
    if (vote.reject.size >= vote.rejectNeed) { void settleTimeVote('rejected'); return }
    void broadcastInGame('【投票 ' + vote.id + '】' + player + ' 反对（' + vote.reject.size + '/' + vote.rejectNeed + '）。')
  }

  const timeTail = createLogTail(serverDir, (evt) => {
    try { handleTimeVoteChat(evt) } catch { /* 单条聊天失败不影响 */ }
  }, { intervalMs: 700 })
  ctx.effect(() => {
    timeTail.startAtEnd()
    timeTail.start()
    return () => { timeTail.stop(); clearTimeVote() }
  })

  // ── 游戏时长门槛 ──
  // 白名单开启时，已绑定但游戏时长不足门槛的玩家，禁止让小铜操作服务器（聊天照常）。
  const playtimeGatedSessions = new Set()
  const playtimeGateCfg = () => (liveConfig && liveConfig.ai) || {}
  const gateLog = (m) => { try { appendFileSync(join(opsDir, 'data', 'mc-ai.log'), new Date().toISOString() + ' ' + m + '\n') } catch { } }

  /** 单个游戏名的门槛状态；无法判断（没 stat 文件）时 gated=false，不误伤。 */
  const playtimeGateState = (name) => playtimeGateStateFor(name, playtimeGateCfg(), paths.serverDir)

  /** QQ openid → 他绑定的游戏账号里时长最长的那个。 */
  const playtimeGateForQq = (qq) => playtimeGateForQqFor(qq, playtimeGateCfg(), paths.serverDir)

  /** 每次 /mc-ai 请求都按最新时长刷新这个会话的门槛状态。 */
  const refreshPlaytimeGate = (key, playerName, uuid) => {
    try {
      const st = playtimeGateStateFor(playerName, playtimeGateCfg(), paths.serverDir, uuid)
      // 门槛判定写进 mc-ai.log，方便排查「为什么这个人被拦/没被拦」
      gateLog('[gate] ' + (playerName || '?') + ' uuid=' + String(uuid || '').slice(0, 8)
        + ' 时长=' + (st.minutes === null ? '未知' : Math.round(st.minutes) + '分')
        + ' 门槛=' + Math.round(st.need) + '分 白名单=' + (whitelistEnabled(paths.serverDir) ? 'on' : 'off')
        + ' → ' + (st.gated ? '拦截' : '放行'))
      if (st.gated) playtimeGatedSessions.add(key)
      else playtimeGatedSessions.delete(key)
    } catch (error) {
      gateLog('[gate] 判定失败：' + (error && error.message ? error.message : String(error)))
      playtimeGatedSessions.delete(key)
    }
  }

  // ── 游戏内 AI 对话：给 Forge mod 的本地 HTTP 入口 ──
  // 玩家在游戏里 /ai 内容 → mod POST 到 127.0.0.1:<port>/mc-ai → 这里开一个 agent 回合
  // → 拿回复回给 mod。会话 id 形如 mc-ai:<uuid>，不是本机会话，所以走「群友」权限。
  // mod 1.1.0 起请求还能带 1 个附件：图片存进 DSH 的 attachments 存储后随消息给模型看；
  // 小文本文件直接内联进消息文本，大文件/二进制才落盘，由 DSH 投影成只读路径给 agent 读。
  const aiCfg = Object.assign({ enabled: true, port: 8765, timeoutSeconds: 60 }, (liveConfig && liveConfig.ai) || {})
  if (aiCfg.enabled) {
    const aiSessions = new Map()
    const aiQueues = new Map()
    const aiLog = (m) => {
      try { appendFileSync(join(opsDir, 'data', 'mc-ai.log'), new Date().toISOString() + ' ' + m + '\n') } catch { }
    }

    // options.timeoutMs：覆盖默认 ai.timeoutSeconds（/mc-ai 不传，行为不变）；
    // options.setup：建/恢复 agent 时挂的初始化（/mc-exchange 用来屏蔽工具）。
    const askAgent = async (key, text, attachmentItems = [], agentCallOptions = {}) => {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.create !== 'function') throw new Error('DSH 没有可用的 agents 服务')
      let agent = aiSessions.get(key)
      if (!agent || !agents.get(key)) {
        // agents.create 不会自动套用部署默认模型；不传 agentOptions 时，第一轮
        // prepareStep 会抛 "has no provider/model"，turn/end 之后回复是空的。
        // 所以从 dsh-agent-default-model 取一份 provider/model 路由传进去。
        const defaultModel = ctx.get('agentDefaultModel')
        const route = defaultModel && typeof defaultModel.currentSelection === 'function'
          ? defaultModel.currentSelection()
          : undefined
        const createOptions = { sessionId: key, agentOptions: route, meta: { cwd: serverDir } }
        const resumeOptions = { resumeSessionId: key, agentOptions: route }
        if (typeof agentCallOptions.setup === 'function') {
          createOptions.setup = agentCallOptions.setup
          resumeOptions.setup = agentCallOptions.setup
        }
        let handle
        try {
          handle = await agents.create(createOptions)
        } catch (createError) {
          // 玩家之前聊过、会话已经落盘（DSH 重启后内存里的 agent 不在了）：
          // create 会因 session id 已存在而失败，这时恢复旧会话继续聊。
          try {
            handle = await agents.resume(resumeOptions)
          } catch {
            throw createError
          }
        }
        agent = handle.agent
        aiSessions.set(key, agent)
        // 恢复出来的会话可能记着一条旧的（甚至已经失效的）模型路由，AgentModel 会
        // 优先用记录值。这里把当前默认路由显式写进选择，覆盖旧记录。
        if (route && agent.model && typeof agent.model.select === 'function') {
          try { agent.model.select(route) } catch (error) {
            aiLog('[ai] ' + key + ' 设置模型路由失败：' + (error && error.message ? error.message : String(error)))
          }
        }
      }
      // 附件组装：图片块给模型直接看；小文本文件直接内联成 text 块（不依赖 agent 的文件工具）；
      // 超过 100KB 或二进制的文件才落进 DSH 的 attachments 存储，靠 file 块的只读路径投影给 agent 读。
      const content = [{ type: 'text', text }]
      if (attachmentItems.length) {
        let store = null
        for (const item of attachmentItems) {
          if (item.kind === 'file' && item.inlineText !== null) {
            content.push({
              type: 'text',
              text: '--- 附件：' + item.name + '（' + item.bytes.byteLength + ' 字节，已内联）---\n'
                + item.inlineText + '\n--- 附件结束 ---',
            })
            continue
          }
          if (!store) {
            store = ctx.get('attachments')
            if (!store || typeof store.saveImages !== 'function' || typeof store.saveFile !== 'function') {
              throw new Error('DSH 没有可用的 attachments 服务')
            }
          }
          try {
            content.push(await storeMcAiAttachment(store, item))
          } catch (error) {
            throw new Error('附件保存失败：' + (error && error.message ? error.message : String(error)))
          }
        }
      }
      const timeoutMs = Number(agentCallOptions.timeoutMs) > 0
        ? Math.max(1000, Number(agentCallOptions.timeoutMs))
        : Math.max(5, Number(aiCfg.timeoutSeconds) || 60) * 1000
      // 优先用 DSH 自己的构造函数，拿不到就手搓一个同形状的消息
      let message = null
      try {
        const llm = await import('@deepseek-ai/dsh-llm')
        if (llm && typeof llm.createUserMessage === 'function') {
          message = llm.createUserMessage({ content, source: { kind: 'user' } })
        }
      } catch { /* 拿不到就退回手搓 */ }
      if (!message) {
        message = {
          id: 'mcai-' + randomUUID(),
          role: 'user',
          content,
          source: { kind: 'user' },
          time: Date.now(),
        }
      }
      const parts = []
      let endReason = null
      const reply = await new Promise((resolve, reject) => {
        let off = () => { }
        const timer = setTimeout(() => {
          try { off() } catch { }
          try { agent.cancel({ kind: 'hook', reason: 'in-game timeout' }) } catch { }
          reject(new Error('AI 回复超时'))
        }, timeoutMs)
        off = ctx.on('session/event', (session, event) => {
          const id = session && session.header ? String(session.header.id ?? '') : ''
          if (id !== key) return
          if (event.type === 'assistant/message') {
            const content = event.data && event.data.message ? event.data.message.content : null
            for (const block of content || []) {
              if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
            }
          }
          if (event.type === 'turn/end') {
            endReason = event.data && event.data.reason ? event.data.reason : null
            clearTimeout(timer)
            try { off() } catch { }
            resolve(parts.join('\n').trim())
          }
        }, { global: true })
        try { agent.followup(message) } catch (error) {
          clearTimeout(timer)
          try { off() } catch { }
          reject(error)
        }
      })
      if (!reply && endReason && endReason.kind === 'error') {
        // 不要把模型/鉴权错误吞成「小铜没说话」：真实原因记进日志，也让 mod 显示出来
        const failure = endReason.error || {}
        const detail = String(failure.message || failure.code || '未知错误')
        aiLog('[ai] ' + key + ' 回合失败：' + detail)
        throw new Error('AI 请求失败：' + detail)
      }
      return reply
    }

    /** 同一玩家串行，避免并发打断同一个会话 */
    const enqueue = (key, task) => {
      const prev = aiQueues.get(key) || Promise.resolve()
      const next = prev.then(task, task)
      aiQueues.set(key, next.catch(() => { }))
      return next
    }

    // ── /mc-exchange：AIMCmarket 的市场接口（默认关闭）──
    // 同一个 HTTP 服务，独立会话 key（mc-exchange:<task>）+ 独立 system prompt（只输出 JSON）。
    // 关闭时直接 404，不读 body、不建会话、不消耗 token；打开后配置每次请求现读，热生效。
    const exchangeLog = (m) => {
      try { appendFileSync(join(opsDir, 'data', MC_EXCHANGE_LOG_NAME), new Date().toISOString() + ' ' + m + '\n') } catch { }
    }
    const exchangeHits = []
    /** 滑动 60 秒全局限流；返回 true 表示这单被限流。 */
    const exchangeRateLimited = (maxPerMinute) => {
      const now = Date.now()
      const windowStart = now - 60000
      while (exchangeHits.length && exchangeHits[0] <= windowStart) exchangeHits.shift()
      const limit = Math.round(clampNumber(maxPerMinute, 30, 1, 600))
      if (exchangeHits.length >= limit) return true
      exchangeHits.push(now)
      return false
    }
    // exchange 会话不需要工具：建/恢复 agent 时把这个 agent 作用域里的全局工具全部屏蔽。
    // 好处是 prompt 里没有工具说明、模型只输出 JSON，也堵掉「借工具碰服务器」的路。
    const exchangeAgentSetup = (agentCtx) => {
      try {
        const scopedTools = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get('tools') : null
        if (!scopedTools || typeof scopedTools.restrict !== 'function') return
        const registry = ctx.get('tools')
        const names = registry && typeof registry.definitions === 'function'
          ? registry.definitions().map((definition) => String((definition && definition.name) || '')).filter(Boolean)
          : []
        if (!names.length) return
        scopedTools.restrict({ deny: names })
      } catch (error) {
        exchangeLog('[exchange] 屏蔽工具失败：' + clipLogMessage(shortErrorMessage(error)))
      }
    }

    const handleExchange = async (req, res) => {
      const send = (code, obj) => {
        try {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        } catch { }
      }
      const cfg = currentExchangeConfig()
      if (cfg.enabled !== true) {
        // 关闭时：不读 body、不建会话、不花 token，只留一行 debug 日志。
        try { req.resume() } catch { }
        exchangeLog('[exchange] disabled 拒绝一次请求（设置里 exchange.enabled=false）')
        return send(404, { ok: false, error: 'exchange disabled' })
      }
      const startedAt = Date.now()
      const body = await readCappedBody(req, MC_EXCHANGE_MAX_BODY_BYTES)
      if (body.tooBig) return send(400, { ok: false, error: '请求体太大（上限 1MB）' })
      if (body.error) return send(400, { ok: false, error: body.error })
      let parsed = null
      try { parsed = JSON.parse(body.text || '{}') } catch { parsed = null }
      if (!parsed) {
        exchangeLog('[exchange] 400 请求体不是合法 JSON')
        return send(400, { ok: false, error: '请求体不是合法 JSON' })
      }
      const request = normalizeExchangeRequest(parsed)
      if (!request.ok) {
        exchangeLog('[exchange] 400 ' + clipLogMessage(request.error))
        return send(400, { ok: false, error: request.error })
      }
      const maxPerMinute = clampNumber(cfg.maxPerMinute, 30, 1, 600)
      if (exchangeRateLimited(maxPerMinute)) {
        exchangeLog('[exchange] 429 ' + request.task + '（超过 ' + Math.round(maxPerMinute) + ' 次/分钟）')
        return send(429, { ok: false, error: 'rate limited' })
      }
      if (request.task === 'ping') {
        const data = { version: localVersion() || '0.7.0', tasks: EXCHANGE_AGENT_TASKS.slice() }
        exchangeLog('[exchange] ping ' + (Date.now() - startedAt) + 'ms ok')
        return send(200, { ok: true, data, elapsedMs: Date.now() - startedAt })
      }
      const timeoutSeconds = clampNumber(cfg.timeoutSeconds, 20, 1, 300)
      const maxContextChars = clampNumber(cfg.maxContextChars, 20000, 100, 200000)
      const deadline = startedAt + timeoutSeconds * 1000
      const context = limitExchangeContext(request.context, maxContextChars)
      const message = limitExchangeMessage(request.message)
      const prompt = buildExchangeUserPrompt(request.task, message, context.text)
      const key = MC_EXCHANGE_SESSION_PREFIX + request.task
      const taskLog = (succeeded, repaired, extra) => exchangeLog(
        '[exchange] ' + request.task + ' ' + (Date.now() - startedAt) + 'ms repaired=' + (repaired ? 1 : 0)
        + ' ok=' + (succeeded ? 1 : 0) + ' ctx=' + context.text.length + (context.truncated ? ' truncated=1' : '')
        + (extra ? ' ' + extra : ''),
      )
      void enqueue(key, async () => {
        const remaining = () => deadline - Date.now()
        let lastRaw = ''
        let repaired = false
        try {
          if (remaining() < 1000) throw new Error('排队等待过久，已超时')
          let reply = await askAgent(key, prompt, [], {
            timeoutMs: Math.max(1000, remaining()),
            setup: exchangeAgentSetup,
          })
          lastRaw = reply
          let outcome = parseExchangeReply(request.task, reply)
          repaired = repaired || outcome.repaired === true
          if (!outcome.ok) {
            // JSON 兜底失败：把错误摘要发回模型重试一次（只输出 JSON）；时间不够就不重试。
            const retryBudget = remaining()
            if (retryBudget >= 3000) {
              exchangeLog('[exchange] ' + request.task + ' JSON 校验失败，重试一次：' + clipLogMessage(outcome.error))
              reply = await askAgent(key, buildExchangeRetryPrompt(outcome.error), [], {
                timeoutMs: retryBudget,
                setup: exchangeAgentSetup,
              })
              lastRaw = reply
              outcome = parseExchangeReply(request.task, reply)
              repaired = repaired || outcome.repaired === true
            }
          }
          if (!outcome.ok) {
            taskLog(false, repaired, 'reason=' + clipLogMessage(outcome.error))
            return send(200, { ok: false, error: outcome.error, raw: String(lastRaw || '').slice(0, 600) })
          }
          taskLog(true, repaired)
          return send(200, { ok: true, data: outcome.data, elapsedMs: Date.now() - startedAt })
        } catch (error) {
          const messageText = shortErrorMessage(error)
          taskLog(false, repaired, 'reason=' + clipLogMessage(messageText))
          return send(200, { ok: false, error: messageText })
        }
      }).catch((error) => {
        // enqueue 本身异常（理论上不会）：兜底回 JSON，别让请求悬着。
        const messageText = shortErrorMessage(error)
        exchangeLog('[exchange] ' + request.task + ' 内部错误：' + clipLogMessage(messageText))
        send(200, { ok: false, error: messageText })
      })
    }

    const aiServer = createServer((req, res) => {
      const send = (code, obj) => {
        try {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        } catch { }
      }
      const remote = String((req.socket && req.socket.remoteAddress) || '')
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
        return send(403, { ok: false, error: '只接受本机请求' })
      }
      // /mc-exchange 和 /mc-ai 共用这个本地服务；/mc-ai 的分支保持原样。
      const requestUrl = String(req.url || '')
      if (req.method === 'POST' && requestUrl.split('?')[0] === '/mc-exchange') {
        return void handleExchange(req, res).catch((error) => {
          try { send(200, { ok: false, error: shortErrorMessage(error) }) } catch { }
        })
      }
      if (req.method !== 'POST' || !requestUrl.startsWith('/mc-ai')) {
        return send(404, { ok: false, error: 'not found' })
      }
      const chunks = []
      let bodyBytes = 0
      let bodyTooBig = false
      req.on('data', (c) => {
        if (bodyTooBig) return
        bodyBytes += c.length
        if (bodyBytes > MC_AI_MAX_BODY_BYTES) {
          // 超限的请求体直接丢弃，按合约回 JSON（200 + ok:false），连接不炸。
          bodyTooBig = true
          chunks.length = 0
          return
        }
        chunks.push(Buffer.from(c))
      })
      req.on('end', () => {
        if (bodyTooBig) return send(200, { ok: false, error: '请求体太大（附件总大小上限 ' + (MC_AI_TOTAL_MAX_BYTES / 1024 / 1024) + 'MB）' })
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = null }
        if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON' })
        const player = String(body.player || '').slice(0, 32)
        const uuid = String(body.uuid || player).slice(0, 64)
        const text = String(body.text || '').trim().slice(0, 1000)
        // 附件先整体校验：坏 base64 / 未知媒体类型 / 超限都在开 agent 回合之前拒掉，
        // 不让异常冒到服务外面。校验通过后再在队列里落盘、组消息。
        const attachmentResult = normalizeMcAiAttachments(body.attachments)
        if (!attachmentResult.ok) {
          aiLog('[ai] ' + (player || '?') + ' 附件被拒：' + attachmentResult.error)
          return send(200, { ok: false, error: attachmentResult.error })
        }
        const attachmentItems = attachmentResult.items
        if (!text && !attachmentItems.length) return send(400, { ok: false, error: '内容不能为空' })
        const attSummary = describeMcAiAttachments(attachmentItems)
        const key = 'mc-ai:' + (uuid || player)
        refreshPlaytimeGate(key, player, uuid)
        const startedAt = Date.now()
        enqueue(key, async () => {
          try {
            const reply = await askAgent(key, text, attachmentItems)
            aiLog('[ai] ' + player + ' → ' + text.slice(0, 60) + (attSummary ? ' ' + attSummary : '') + ' ⇒ ' + String(reply || '').slice(0, 60))
            send(200, { ok: true, reply: reply || '（小铜没说话）', elapsedMs: Date.now() - startedAt })
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            aiLog('[ai] ' + player + (attSummary ? ' ' + attSummary : '') + ' 失败：' + message)
            send(200, { ok: false, error: message })
          }
        })
      })
      req.on('error', () => { try { send(400, { ok: false, error: '请求读取失败' }) } catch { } })
    })

    ctx.effect(() => {
      aiServer.on('error', (error) => aiLog('[ai] 监听失败：' + (error && error.message ? error.message : String(error))))
      try { aiServer.listen(aiCfg.port, '127.0.0.1') } catch (error) {
        aiLog('[ai] 启动失败：' + (error && error.message ? error.message : String(error)))
      }
      aiLog('[ai] 已监听 127.0.0.1:' + aiCfg.port)
      return () => { try { aiServer.close() } catch { } }
    })
  }

  // 依赖可能比本插件晚就绪，用 ctx.inject 等它们可用再挂路由。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings', 'webServer'], (scope) => {
      const webServer = scope.get('webServer')
      if (!webServer || typeof webServer.register !== 'function') return
      scope.effect(() => webServer.register({
        kind: 'prefix',
        path: '/mc-ops/config',
        handler: (req, res) => handleConfigRoute(req, res, { settings: scope.get('settings'), editor: scope.get('configEditor') }, memoryConfig),
      }))
      scope.effect(() => webServer.register({
        kind: 'prefix',
        path: '/mc-ops/update',
        handler: (req, res) => handleUpdateRoute(req, res),
      }))
    })
  }
  const tools = ctx.get('tools')
  if (!tools || typeof tools.register !== 'function') return

  ctx.effect(() => tools.register({
    name: 'mc_server',
    // 工具描述必须是字符串（API 侧 schema 只接受 string）。DESCRIPTION 已经是 join 后的字符串，
    // 这里按行切分后替换首行，再拼回字符串。
    description: ['Minecraft 服务器（' + paths.serverDir + '）的操作入口。', ...DESCRIPTION.split('\n').slice(1)].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: '要执行的操作',
        },
        arg: {
          type: 'string',
          description: 'say 的内容、cmd 的指令（不带斜杠）、weather 的天气类型（clear/rain/thunder）、口令，其它操作为空',
        },
        channel: {
          type: 'string',
          enum: ['c2c', 'group', 'unknown'],
          description: '当前对话类型：私聊填 c2c，群聊填 group。绑定服主口令只接受 c2c。',
        },
        actor: {
          type: 'string',
          description: '发送者 ID：原样取自群消息开头的 [昵称 (ID)] 标记',
        },
      },
      required: ['action', 'actor'],
      additionalProperties: false,
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      let action = String((args && args.action) || '')
      if (!ACTIONS.includes(action)) throw new Error('mc_server: 不支持的 action: ' + action)
      const actor = String((args && args.actor) || '').trim()
      if (!actor) throw new Error('mc_server: actor 不能为空（必须取自 [昵称 (ID)] 标记）')
      // 兼容旧习惯：模型可能用 cmd 发「weather rain」。只要整个参数就是天气命令，
      // 就转成 weather 动作处理（玩家也能走，不再被 cmd 的服主限制拦住）。
      // 注意：args 对象是只读的（工具层冻结），不要原地改 args.arg，用局部变量覆盖。
      let weatherArgOverride = null
      if (action === 'cmd') {
        const cmdArg = String((args && args.arg) || '').trim()
        const weatherMatch = /^weather\s+(clear|rain|thunder|sunny|晴天|下雨|雷雨)\s*$/i.exec(cmdArg)
        if (weatherMatch) {
          weatherArgOverride = weatherMatch[1]
          action = 'weather'
        }
      }
      const agentIdForGate = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
      // 白名单 + 绑定但游戏时长不足：禁止用 AI 做服务器操作（查询类放行，聊天不受影响）。
      // 游戏内 AI 会话（mc-ai:<uuid>）由 tools.guard 按 uuid 判定门槛，这里不要再按
      // actor（模型会填玩家名，不是 QQ）判一次，否则老玩家会被当成「未绑定」误拦。
      const isMcAiSession = agentIdForGate.startsWith('mc-ai:')
      if (!isOwner(actor) && !isMcAiSession && !isLocalSession(agentIdForGate) && !READ_ONLY_ACTIONS.includes(action)) {
        const gate = playtimeGateForQq(actor)
        if (gate.gated) {
          gateLog('[gate] ' + actor.slice(0, 8) + ' action=' + action + ' 未通过：' + gate.reason
            + ' 时长=' + (gate.minutes === null ? '未知' : Math.round(gate.minutes) + '分') + ' 门槛=' + Math.round(gate.need))
          if (gate.reason === 'unbound') {
            return {
              ok: false,
              text: '白名单开启时，没绑定游戏账号就没法验证游戏时长，暂时不能让小铜操作服务器。'
                + '先用 bind-player 绑定你的游戏名（进服玩够 ' + Math.round(gate.need) + ' 分钟），查询状态和聊天不受影响。',
            }
          }
          if (gate.reason === 'unknown') {
            return {
              ok: false,
              text: '查不到你绑定账号（' + (gate.name || '?') + '）的游戏时长，白名单开启时暂时不能让小铜操作服务器。'
                + '确认这个号至少进过一次服，或者找服主处理；查询状态和聊天不受影响。',
            }
          }
          return {
            ok: false,
            text: '你绑定的游戏账号「' + (gate.name || '?') + '」游戏时长才 '
              + Math.round(gate.minutes) + ' 分钟（门槛 ' + Math.round(gate.need) + ' 分钟），'
              + '暂时不能让小铜操作服务器。查询状态、聊天不受影响，玩够时间再试。',
          }
        }
      }
      if ((action === 'owner-add' || action === 'owner-del') && !isLocalSession(agentIdForGate)) {
        return { ok: false, text: '增删服主只能在设置面板里做，或者到服务器本机执行。' }
      }
      if (!isOwner(actor)) {
        if (action === 'cmd') return { ok: false, text: '执行后台命令只有服主能做。' }
        if (action === 'export-data' || action === 'import-data' || action === 'whitelist-sync' || action === 'bindings' || action === 'bridge-groups') {
          return { ok: false, text: '这个操作只有服主能做。' }
        }
        const denied = checkActionAllowed(action, currentPerms())
        if (denied) return { ok: false, text: denied }
      }
      // Channel 由会话决定，不信模型自己填：本机会话=console，QQ 会话=group，只有私聊且模型声明 c2c 才算 c2c
      const channel = isLocalSession(agentIdForGate) ? 'console' : (String((args && args.channel) || '') === 'c2c' ? 'c2c' : 'group')
      const cli = ['-Action', action, '-Actor', actor, '-Channel', channel]
      const arg = weatherArgOverride !== null ? weatherArgOverride : (args && args.arg !== undefined && args.arg !== null ? String(args.arg) : '')
      if (arg !== '') cli.push('-Arg', arg)
      // ── 出网前的三道闸 ──
      // ① 权限校验：上面已经拦掉服主专属动作和设置里关掉的功能
      // ② 投票放行：服主本人，或本会话刚通过群友投票（grant 窗口）
      // ③ 静态拦截：command-guard.mjs 只拦“一条命令搞崩整个服”的类型
      // 三道全过才真正发给 RCON。
      if (action === 'cmd' || action === 'say') {
        const owner = isOwner(actor)
        const voteCleared = hasToolGrant(agentIdForGate)
        const raw = action === 'say' ? 'say ' + arg : arg
        const verdict = guardCommand(raw, { id: actor, owner })
        if (!verdict.ok) {
          const who = owner ? '服主' : (voteCleared ? '已投票放行的会话' : '玩家')
          return { ok: false, text: '⛔ 命令被拦截（' + who + '）：' + verdict.reason }
        }
      }

      // 群服互通：列机器人加入的群，供填 bridge.groups
      if (action === 'bridge-groups') {
        const auto = readQqbotCredentials()
        const bCfg = (liveConfig && liveConfig.bridge) || {}
        const appId = String(bCfg.appId || (auto && auto.appId) || '')
        const appSecret = String(bCfg.appSecret || (auto && auto.appSecret) || '')
        try {
          const groups = await new QqApi({ appId, appSecret }).listGroups()
          if (!groups.length) return { ok: true, text: '机器人还没加入任何群（或者没有「群管理」权限，拿不到群列表）。' }
          rememberBridgeGroups(groups.map((g) => g.openid))
          return { ok: true, text: groups.map((g) => g.name + '\n  ' + g.openid).join('\n') }
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          const local = [...new Set([...loadRememberedBridgeGroups(), ...loadCapturedBridgeGroups()])]
          if (local.length) {
            return {
              ok: true,
              text: 'QQ 接口不支持直接列群（' + message + '），改用本地记录到的群 openid：\n'
                + local.join('\n')
                + '\n\n填到「群服互通 → 转发到哪些群」即可；留空也会自动用这些群。',
            }
          }
          return { ok: false, text: '查群列表失败：' + message + '\n（需要 AppID/AppSecret，以及开放平台的「群管理」权限；也可以让群友在群里 @ 一次机器人来捕获群 openid）' }
        }
      }

      // 天气投票：玩家也能用（不需要服主权限）。
      // - 服主/控制台：直接执行 weather 命令（相当于控制台发起，不投票）
      // - 玩家：用他绑定且当前在线的游戏名执行 execute as <name> run weather <type>，
      //   mod 会按在线人数决定直接生效还是发起游戏内投票（/vote yes）。
      if (action === 'weather') {
        const weatherCfg = (liveConfig && liveConfig.weather) || {}
        if (weatherCfg.enabled === false) return { ok: false, text: '天气功能已经在设置里关掉了（设置 → 游戏内天气投票）。' }
        const type = normalizeWeatherType(arg)
        if (!type) return { ok: false, text: '用法：weather <clear|rain|thunder>（晴天 / 下雨 / 雷雨）' }
        const typeName = WEATHER_NAMES[type]
        const threshold = Math.max(0, Number(weatherCfg.directThreshold) || 0)
        const approveNeed = Math.max(1, Number(weatherCfg.approveNeed) || 2)
        if (isOwner(actor)) {
          const done = await runMcAdmin(['-Action', 'cmd', '-Arg', 'weather ' + type, '-Actor', 'LOCAL-CONSOLE', '-Channel', 'console'], 60000)
          if (!done.ok) return { ok: false, text: '改天气失败：' + done.text }
          return { ok: true, text: '天气已改成「' + typeName + '」（服主直接执行，不投票）。' }
        }
        const mine = readPlayerBindings().filter((b) => b.qq === actor).map((b) => b.name)
        const playersResult = await runMcAdmin(['-Action', 'players', '-Actor', actor, '-Channel', channel], 30000)
        if (!playersResult.ok) return { ok: false, text: '拿不到在线人数（players 失败），稍后再试，避免绕过投票。' }
        const online = parseOnlinePlayers(playersResult.ok ? playersResult.text : '')
        const onlineName = mine.find((name) => online.some((p) => p.toLowerCase() === name.toLowerCase()))
        // 没有绑定或不在线时：在线人少（≤ 免投票阈值）不需要身份也能直接生效。
        if (!onlineName) {
          const who = !mine.length ? '你还没绑定游戏名' : '你绑定的游戏名（' + mine.join(', ') + '）现在都不在线'
          if (online.length <= threshold) {
            const direct = await runMcAdmin(['-Action', 'cmd', '-Arg', 'weather ' + type, '-Actor', 'LOCAL-CONSOLE', '-Channel', 'console'], 60000)
            if (!direct.ok) return { ok: false, text: '改天气失败：' + direct.text }
            return { ok: true, text: who + '；不过当前在线 ' + online.length + ' 人（≤' + threshold + '，不用投票），已直接改成「' + typeName + '」。' }
          }
          return {
            ok: false,
            text: who + '，而当前在线 ' + online.length + ' 人（超过 ' + threshold + '），改天气需要游戏内投票。'
              + '先发「绑定游戏名 你的ID」并进服，或者直接在游戏里输入 /weather ' + type + ' 发起。',
          }
        }
        const started = await runMcAdmin(['-Action', 'cmd', '-Arg', 'execute as ' + onlineName + ' run weather ' + type, '-Actor', 'LOCAL-CONSOLE', '-Channel', 'console'], 60000)
        if (!started.ok) return { ok: false, text: '发起天气请求失败：' + started.text }
        const how = online.length <= threshold
          ? '当前在线 ' + online.length + ' 人（≤' + threshold + '），会直接生效'
          : '当前在线 ' + online.length + ' 人，游戏里已经发起投票，需要 ' + approveNeed + ' 票同意（其他玩家输入 /vote yes）'
        return { ok: true, text: '已用你的游戏名 ' + onlineName + ' 发起：把天气改成「' + typeName + '」。' + how + '。' }
      }

      // 时间投票：玩法照搬天气——服主直接执行；玩家在线人少直接生效，人多走游戏内聊天投票。
      if (action === 'time') {
        const timeCfg = (liveConfig && liveConfig.time) || {}
        if (timeCfg.enabled !== true) {
          return { ok: false, text: '时间投票已经在设置里关掉了（设置 → 游戏内时间投票，默认关闭）。' }
        }
        const target = normalizeTimeArg(arg)
        if (!target) {
          return { ok: false, text: '用法：time <day|noon|sunset|night|midnight|sunrise|0-24000>（也可以写 白天 / 夜晚 / 中午 / 午夜 …）' }
        }
        const threshold = Math.max(0, Number(timeCfg.directThreshold) || 0)
        const cooldownMs = Math.max(0, Number(timeCfg.cooldownSeconds) || 0) * 1000
        const lastAt = timeCooldown.get(actor) || 0
        if (cooldownMs > 0 && !isOwner(actor) && Date.now() - lastAt < cooldownMs) {
          const wait = Math.ceil((cooldownMs - (Date.now() - lastAt)) / 1000)
          return { ok: false, text: '刚改过时间，' + wait + ' 秒后再来。' }
        }
        if (isOwner(actor)) {
          const done = await applyTimeTarget(target)
          if (!done.ok) return { ok: false, text: '改时间失败：' + done.text }
          timeCooldown.set(actor, Date.now())
          return { ok: true, text: '时间已改成「' + target.name + '」（服主直接执行，不投票）。' }
        }
        const mine = readPlayerBindings().filter((b) => b.qq === actor).map((b) => b.name)
        const playersResult = await runMcAdmin(['-Action', 'players', '-Actor', actor, '-Channel', channel], 30000)
        if (!playersResult.ok) return { ok: false, text: '拿不到在线人数（players 失败），稍后再试，避免绕过投票。' }
        const online = parseOnlinePlayers(playersResult.text)
        // 游戏内 /ai 传进来的 actor 可能就是玩家名：名字在线也算有效候选
        const actorAsName = online.find((p) => p.toLowerCase() === String(actor).toLowerCase())
        const candidates = (actorAsName && !mine.some((n) => n.toLowerCase() === actorAsName.toLowerCase())) ? mine.concat([actorAsName]) : mine
        const onlineName = candidates.find((name) => online.some((p) => p.toLowerCase() === name.toLowerCase()))
        if (online.length <= threshold) {
          const done = await applyTimeTarget(target)
          if (!done.ok) return { ok: false, text: '改时间失败：' + done.text }
          timeCooldown.set(actor, Date.now())
          return {
            ok: true,
            text: '当前在线 ' + online.length + ' 人（≤' + threshold + '，不用投票），已把时间改成「' + target.name + '」。',
          }
        }
        if (!onlineName) {
          const who = !mine.length ? '你还没绑定游戏名' : '你绑定的游戏名（' + mine.join(', ') + '）现在都不在线'
          return {
            ok: false,
            text: who + '，而当前在线 ' + online.length + ' 人（超过 ' + threshold + '），改时间需要游戏内投票。'
              + '先进服并绑定，或者在游戏里直接说「改成白天」。',
          }
        }
        const started = await startTimeVote({ target, by: actor, initiatorName: onlineName })
        if (started.ok) timeCooldown.set(actor, Date.now())
        return started
      }

      const isWindows = process.platform === 'win32'
      if (!isWindows && !NODE_ACTIONS.has(action)) {
        return { ok: false, text: `（${process.platform}）${action} 还没跨平台，目前只在 Windows 上可用。跨平台可用的是：${[...NODE_ACTIONS].join(' / ')}` }
      }
      const useNode = !isWindows && NODE_ACTIONS.has(action) && existsSync(NODE_RUNNER)
      let result
      if (ADAPTER_ACTIONS.has(action)) {
        const adapter = currentAdapter()
        const adapterOpts = { actor, channel, owner: isOwner(actor), timeoutMs: 170000 }
        result = action === 'cmd'
          ? await adapter.sendCommand(arg, adapterOpts)
          : await adapter[action](adapterOpts)
      } else {
        result = useNode ? await runNodeOps(action, arg, 60000, isOwner(actor)) : await runMcAdmin(cli, 170000)
      }
      if (isOwner(actor)) {
        grantTools(exec && exec.agent ? exec.agent.id : undefined)
      }
      else if (action === 'vote-approve' && /投票通过/.test(result.text)) {
        // 两人确认通过后，给这个会话 10 分钟高权限窗口，用来做约定的修复
        grantTools(exec && exec.agent ? exec.agent.id : undefined)
      }
      return { ok: result.ok, text: result.text }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : { ok: false, text: String(value) }
        return [{ type: 'text', text: String(v.text || '') }]
      },
    },
  }))

  // QQ 侧根会话强制用 danger-full-access。
  // 会话权限在创建时就定格了，只改 defaultPreset 追不到老会话，于是老群会话一直
  // 停在 workspace-write：pwsh 在该模式下起不来（0xC0000142），每次都申请提权 -> 群里点允许。
  // 这里在每轮 turn/start（工具开跑之前）把非本机的根会话纠正一次，老会话也能立刻恢复。
  if (typeof ctx.on === 'function') {
    // session/event 是在会话提交过程中派发的，此时直接 append 会报
    // "session append cannot reenter while another append is being published"，
    // 所以丢到下一个宏任务里做，并对「正在发布」这类错误重试。
    const flipToFullAccess = (session, attempt) => {
      try {
        const header = session && session.header
        if (!header) return
        const id = String(header.id ?? '')
        if (!id || isLocalSession(id)) return
        // /mc-exchange 的会话不给工具，也不需要放宽权限，跳过（少写无意义的 flip 日志）。
        if (exchangeSessionTask(id)) return
        if (header.parentSession || header.origin === 'subagent') return
        const presets = ctx.get('permissionPresets')
        if (!presets || typeof presets.set !== 'function') return
        let current = ''
        try { current = presets.current(session) } catch { current = '' }
        if (current === 'danger-full-access') return
        presets.set(session, 'danger-full-access')
        try { appendFileSync(paths.flipLog, new Date().toISOString() + ' flip ' + id + ' from=' + (current || 'unknown') + '\n') } catch { }
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        if (attempt > 0 && /reenter|being published/i.test(message)) {
          setTimeout(() => flipToFullAccess(session, attempt - 1), 300)
          return
        }
        try { appendFileSync(paths.flipLog, new Date().toISOString() + ' error ' + message + '\n') } catch { }
      }
    }
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'turn/start') return
      setTimeout(() => flipToFullAccess(session, 3), 0)
    }, { global: true }))
  }
  // 权限守卫（QQ 侧会话）：
  // - read / glob / grep：任何人可用，玩家可以查文件；
  // - qqbot_send_file / present：任何人可用，但敏感文件（口令、owners.json 等）拒绝；
  // - pwsh：玩家只放行只读命令；写文件、启进程、联网下载、删改一律拦下；
  // - write / edit / web_*：需要服主授权（12 小时窗口）。
  ctx.effect(() => tools.guard((exec) => {
    const id = exec.agent && exec.agent.id ? String(exec.agent.id) : ''
    // /mc-exchange 的会话只输出 JSON：工具在 agent setup 里已经尽量屏蔽，这里再兜底拒绝一次。
    if (exchangeSessionTask(id)) return '这个会话只输出 JSON，不能调用工具。'
    if (isLocalSession(id)) return undefined
    // 白名单新玩家（游戏时长不足）：AI 只能聊天和查询，不能碰服务器
    if (playtimeGatedSessions.has(id)) {
      const gateArgs = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
      const readOnlyAction = exec.name === 'mc_server' && READ_ONLY_ACTIONS.includes(String(gateArgs.action || ''))
      if (!readOnlyAction && !OPEN_READ_TOOLS.includes(exec.name)) {
        const cfg = playtimeGateCfg()
        const need = Math.round(Math.max(0, Number(cfg.minPlaytimeMinutes) || 60))
        return '你绑定的游戏账号游戏时长还不到 ' + need + ' 分钟（白名单新玩家），暂时不能让小铜操作服务器；聊天和查询不受影响，先玩够时间再来。'
      }
      return undefined
    }
    if (exec.name === 'mc_server') return undefined

    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}

    if (OPEN_READ_TOOLS.includes(exec.name)) return undefined

    if (SEND_TOOLS.includes(exec.name)) {
      const target = String(args.file_path || args.path || '')
      if (!currentPerms().fileSend) {
        return '发文件到群里已经在设置里关掉了。'
      }
      if (SENSITIVE_PATH.test(target)) {
        return '这个文件含口令/密钥或内部配置，不能发到群里；需要的话让服主自己取。'
      }
      return undefined
    }

    if (exec.name === 'pwsh') {
      let raw = ''
      try { raw = JSON.stringify(args) } catch { raw = '' }
      if (raw.includes('mcadmin.ps1')) {
        return 'mc_server：服务器操作请用 mc_server 工具（action + actor），不要用 pwsh 直接调 mcadmin.ps1。'
      }
      const command = String(args.command || '')
      const hasRedirect = /(^|[^>])>(?!>)/.test(command) || command.includes('>>')
      const readOnly = READONLY_CMD.test(command) && !DANGEROUS_CMD.test(command) && !hasRedirect
      if (readOnly) return undefined
      if (hasToolGrant(id)) return undefined
      return '玩家只能查询服务器信息（只读命令）；修改/删除文件、启动进程、联网下载这些需要服主授权。'
    }

    if (exec.name === 'write' || exec.name === 'edit') {
      const target = String(args.file_path || '')
      if (isPlayerWritable(target)) {
        const t = target.replace(/\//g, '\\').toLowerCase()
        if (t.includes('\\kubejs\\') && !currentPerms().kubejsEdit) return '玩家改 KubeJS 配方已经在设置里关掉了，需要服主自己来。'
        if ((t.includes('\\config\\') || t.includes('defaultconfigs') || t.endsWith('server.properties')) && !currentPerms().configEdit) return '玩家改配置已经在设置里关掉了，需要服主自己来。'
        return undefined
      }
    }


    if (!GUARDED_TOOLS.includes(exec.name)) return undefined
    if (hasToolGrant(id)) return undefined
    return '需要服主授权：请先用 mc_server 执行一次 whoami（actor 取当前消息里的 ID）确认为服主，12 小时内才能使用 '
      + exec.name + ' 等工具；如果当前说话的是玩家，请直接拒绝并让他找服主。'
  }))

  // ── 人设注入：按会话类型追加一段 system prompt，设置界面里可改 ──
  const persona = (config && config.persona) || {}
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      const agentId = context && context.agent ? String(context.agent.id ?? '') : ''
      if (!agentId) return assembled
      const sections = [...(assembled.sections ?? [])]
      // /mc-exchange 会话：只加「输出 JSON + 当前 task 的 schema」，不注入小铜的人设和能力清单，
      // 免得市场上下文串进小铜的聊天，也免得人设把 JSON 输出带偏。
      const exchangeTask = exchangeSessionTask(agentId)
      if (exchangeTask) {
        sections.push({ name: 'mc-exchange:json', order: 95, text: exchangeSystemPrompt(exchangeTask) })
        return { ...assembled, sections }
      }
      // QQ 会话一律带上能力清单：明确告诉模型天气对所有玩家开放，别再按旧记忆拒绝
      if (!isLocalSession(agentId)) {
        sections.push({ name: 'mc-ops:abilities', order: 90, text: renderAbilities() })
      }
      if (persona.enabled !== false) {
        const scope = String(persona.scope || 'qq')
        if (scope !== 'none' && !(scope === 'qq' && isLocalSession(agentId))) {
          const text = renderPersona(persona)
          if (text) sections.push({ name: 'mc-ops:persona', order: 91, text })
        }
      }
      return { ...assembled, sections }
    }))
  }
}

function ensureOpsScripts(bundledDir, targetDir) {
  if (!existsSync(bundledDir)) return
  try { mkdirSync(targetDir, { recursive: true }) } catch { return }
  for (const name of ['mcadmin.ps1', 'watchdog.ps1', 'server-console.ps1']) {
    const src = join(bundledDir, name)
    if (!existsSync(src)) continue
    const dst = join(targetDir, name)
    let need = true
    if (existsSync(dst)) {
      try { need = !readFileSync(dst, 'utf8').includes('[string]$ServerDir') } catch { need = true }
    }
    if (need) { try { copyFileSync(src, dst) } catch { } }
  }
}
function runNodeOps(action, arg, timeoutMs, owner) {
  return new Promise((resolve) => {
    let child
    try {
      const argv = [NODE_RUNNER, '--dir', paths.serverDir, '--action', action]
      if (arg !== undefined && arg !== null && String(arg) !== '') argv.push('--arg', String(arg))
      if (owner) argv.push('--owner')
      child = spawn(process.execPath, argv, { windowsHide: true, cwd: paths.serverDir })
    } catch (error) {
      resolve({ ok: false, text: '无法启动 node: ' + (error && error.message ? error.message : String(error)) })
      return
    }
    const chunks = []
    const errChunks = []
    const timer = setTimeout(() => { try { child.kill() } catch { } }, timeoutMs)
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)))
    child.stderr.on('data', (d) => errChunks.push(Buffer.from(d)))
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, text: String(error && error.message ? error.message : error) }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(chunks).toString('utf8').trim()
      const stderr = Buffer.concat(errChunks).toString('utf8').trim()
      if (code === 0) resolve({ ok: true, text: stdout || '(无输出)' })
      else resolve({ ok: false, text: stderr || stdout || ('退出码 ' + code) })
    })
  })
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/** 在本插件的配置条目里找一个能用的 descriptor：ns 可能是 include:xxx / xxx / 包名。 */
function findSettingsEntry(list) {
  const ids = ['mc-server-ops', 'dsh-mc-server-ops']
  for (const d of list) {
    const ns = String(d.ns || '')
    if (ids.some((id) => ns.includes(id))) return d
  }
  for (const d of list) {
    const v = d.value
    if (v && typeof v === 'object' && (v.server || v.persona || v.ops)) return d
  }
  return undefined
}

/** 设置页的读写接口：GET 读当前配置，POST 合并保存。只服务本机 UI。 */
async function handleConfigRoute(req, res, services, fallbackConfig) {
  const send = (code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    } catch { }
  }
  const dataDir = join(paths.serverDir, 'ops', 'data')
  try {
    const settings = services.settings
    const editor = services.editor
    let list = []
    try { list = settings && typeof settings.describe === 'function' ? settings.describe() : [] } catch (error) { list = [] }
    const desc = findSettingsEntry(list)

    // 每次读取都记一份诊断，方便判断走的是哪条路径。
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(join(dataDir, 'settings-debug.json'), JSON.stringify({
        at: new Date().toISOString(),
        nss: list.map((d) => String(d.ns || '')),
        picked: desc ? String(desc.ns) : null,
        hasEditor: !!(editor && typeof editor.edit === 'function'),
        entryIds: editor && typeof editor.entries === 'function' ? editor.entries().map((e) => String(e && e.id ? e.id : '')) : null,
      }, null, 2), 'utf8')
    } catch { }

    // 只服务本机面板：带自定义头的请求浏览器会先发预检，跨站页面伪造不了
    const isPanel = String(req.headers['x-mc-ops-client'] || '') === '1'
    if (!isPanel) return send(403, { error: '只接受来自设置面板的请求' })

    if (req.method === 'GET') {
      const opsPath = join(paths.serverDir, 'ops')
      const owners = readOwnersList(opsPath)
      if (desc) {
        // 更新后配置行可能在、但值是默认值：用备份顶回去，别让面板显示默认值后一保存就覆盖掉。
        const backup = readConfigBackup(paths.serverDir)
        const descValue = backup && isDefaultPluginConfig(desc.value) && !isDefaultPluginConfig(backup)
          ? Object.assign({}, desc.value, backup)
          : desc.value
        return send(200, { ns: String(desc.ns), value: descValue, revision: desc.revision, via: 'settings', owners, bridgeState: readBridgeState(), whitelistState: readWhitelistState(paths.serverDir) })
      }
      // 找不到配置条目时用「内存 + 备份」兜底：更新插件后条目可能暂时缺失，
      // 不能让面板显示成一堆默认值（用户一保存就真把默认值写回去了）。
      const backup = readConfigBackup(paths.serverDir)
      const whitelistState = readWhitelistState(paths.serverDir)
      const fallbackValue = backup ? Object.assign({}, fallbackConfig.get(), backup) : fallbackConfig.get()
      return send(200, { ns: '', value: fallbackValue, revision: 0, via: 'memory', owners, bridgeState: readBridgeState(), whitelistState })
    }
    if (req.method !== 'POST') return send(405, { error: '只支持 GET / POST' })

    const body = await readJsonBody(req)
    if (!body) return send(400, { error: '请求体不是合法 JSON' })
    delete body.regenerateOwnerCode
    const addOwner = typeof body.addOwner === 'string' ? body.addOwner.trim() : ''
    delete body.addOwner
    const removeOwner = typeof body.removeOwner === 'string' ? body.removeOwner.trim() : ''
    delete body.removeOwner
    if (addOwner || removeOwner) {
      const target = addOwner || removeOwner
      if (!/^[A-Za-z0-9:_-]{8,64}$/.test(target)) return send(400, { error: 'QQ 号格式看起来不对（应为群消息里 [昵称 (ID)] 括号中那串）' })
      const cli = ['-Action', addOwner ? 'owner-add' : 'owner-del', '-Arg', target, '-Actor', 'LOCAL-CONSOLE', '-Channel', '']
      const res = await runMcAdmin(cli, 30000)
      if (!res.ok) return send(400, { error: res.text })
      return send(200, { ok: true, owners: readOwnersList(join(paths.serverDir, 'ops')), result: res.text })
    }

    const dirArg = body && body.server && typeof body.server.dir === 'string' ? body.server.dir.trim() : ''
    if (dirArg && (/^[a-zA-Z]:[\\/]?$/.test(dirArg) || /^[\\/]+$/.test(dirArg))) {
      return send(400, { error: '服务器目录不能填盘符根目录，请填具体目录（例如 D:\\server）。' })
    }

    // 面板上「受保护路径」是一个逗号分隔的文本框，存之前转成数组
    if (body && body.vote && typeof body.vote.protectedPaths === 'string') {
      body.vote.protectedPaths = body.vote.protectedPaths.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      if (!body.vote.protectedPaths.length) body.vote.protectedPaths = ['world', 'ops/data', 'whitelist']
    }
    // 群列表同理
    if (body && body.bridge && typeof body.bridge.groups === 'string') {
      body.bridge.groups = body.bridge.groups.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    }
    // 免门槛游戏名同理
    if (body && body.ai && typeof body.ai.trustedPlayers === 'string') {
      body.ai.trustedPlayers = body.ai.trustedPlayers.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    }

    if (desc) {
      await settings.update(desc.ns, body, desc.revision)
      fallbackConfig.set(body)
      saveConfigBackupSafe(body)
      writeWeatherConfig(paths.serverDir, (body && body.weather) || (fallbackConfig.get() || {}).weather)
      return send(200, { ok: true, via: 'settings' })
    }
    if (editor && typeof editor.entries === 'function' && typeof editor.edit === 'function') {
      const entries = editor.entries()
      const entry = entries.find((e) => {
        const id = String(e && e.id ? e.id : '')
        const name = String(e && e.moduleName ? e.moduleName : '')
        return id.includes('mc-server-ops') || name.includes('mc-server-ops')
      })
      if (entry) {
        await editor.edit(entry, (current) => Object.assign({}, current || {}, body))
        fallbackConfig.set(body)
        saveConfigBackupSafe(body)
        writeWeatherConfig(paths.serverDir, (body && body.weather) || (fallbackConfig.get() || {}).weather)
        return send(200, { ok: true, via: 'configEditor' })
      }
    }
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(join(dataDir, 'settings-debug.json'), JSON.stringify({
        at: new Date().toISOString(),
        nss: list.map((d) => String(d.ns || '')),
        entryIds: editor && typeof editor.entries === 'function' ? editor.entries().map((e) => String(e && e.id ? e.id : '')) : 'no-editor',
      }, null, 2), 'utf8')
    } catch { }
    return send(500, { error: '没有找到本插件的配置条目（已写入 ops\\data\\settings-debug.json）' })
  } catch (error) {
    send(500, { error: String(error && error.message ? error.message : error) })
  }
}

/** 读服主名单 */
function readOwnersList(opsPath) {
  try {
    const file = join(opsPath, 'data', 'owners.json')
    if (!existsSync(file)) return []
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(doc.owners) ? doc.owners.map((x) => String(x)) : []
  } catch { return [] }
}

/** 读群服互通的运行状态（插件每 10 秒落一次盘），只把面板需要的字段传出去。 */
function readBridgeState() {
  try {
    const file = join(paths.serverDir, 'ops', 'data', 'bridge-state.json')
    if (!existsSync(file)) return null
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return {
      running: doc.running === true,
      mode: String(doc.mode || ''),
      online: Array.isArray(doc.online) ? doc.online.map(String) : [],
      sentToday: Number(doc.sentToday) || 0,
      lastError: String(doc.lastError || ''),
      at: String(doc.at || ''),
      // 自适应合并窗口的当前判定，给设置页显示用
      coalesce: doc.coalesce && typeof doc.coalesce === 'object' ? doc.coalesce : null,
    }
  } catch { return null }
}



/** 把天气投票配置写到服务器 config/mcai-weather.json；mod 每次 /weather 时读取，改完即时生效。 */
let lastWeatherConfigCore = ''
function writeWeatherConfig(serverDir, weatherCfg) {
  try {
    const src = weatherCfg || {}
    const clampInt = (value, fallback, min, max) => {
      const n = Number(value)
      const v = Number.isFinite(n) ? Math.round(n) : fallback
      return Math.max(min, Math.min(max, v))
    }
    const core = {
      enabled: src.enabled !== false,
      directThreshold: clampInt(src.directThreshold, 2, 0, 20),
      approveNeed: clampInt(src.approveNeed, 2, 1, 20),
      rejectNeed: clampInt(src.rejectNeed, 1, 1, 20),
      timeoutSeconds: clampInt(src.timeoutSeconds, 60, 5, 3600),
      cooldownSeconds: clampInt(src.cooldownSeconds, 60, 0, 86400),
    }
    const coreText = JSON.stringify(core)
    if (coreText === lastWeatherConfigCore) return core
    const dir = join(serverDir, 'config')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcai-weather.json'), JSON.stringify(Object.assign({}, core, {
      updatedAt: new Date().toISOString(),
      managedBy: 'dsh-mc-server-ops',
    }), null, 2) + '\n', 'utf8')
    lastWeatherConfigCore = coreText
    return core
  } catch (error) {
    return null
  }
}

/** 把投票门槛写到 ops\data\vote-config.json，脚本每次调用时读它。 */
function writeVoteConfig(opsPath, voteCfg, fallback) {
  try {
    const src = voteCfg || fallback || {}
    const approveNeed = Math.max(1, Number(src.approveNeed) || 2)
    const rejectNeed = Math.max(1, Number(src.rejectNeed) || 1)
    mkdirSync(join(opsPath, 'data'), { recursive: true })
    const timeoutMinutes = Math.max(1, Number(src.timeoutMinutes) || 15)
    const vetoEnabled = src.vetoEnabled !== false
    const protectedPaths = Array.isArray(src.protectedPaths) && src.protectedPaths.length
      ? src.protectedPaths.map((x) => String(x)).filter(Boolean)
      : ['world', 'ops/data', 'whitelist']
    writeFileSync(join(opsPath, 'data', 'vote-config.json'), JSON.stringify({ approveNeed, rejectNeed, timeoutMinutes, vetoEnabled, protectedPaths }), 'utf8')
  } catch { }
}

/** 玩家侧功能开关：设置里关掉的项直接拒绝，不用等脚本再判一遍。 */
function checkActionAllowed(action, perms) {
  if (action.startsWith('vote-') && !perms.voteEscalation) return '投票放权已经在设置里关掉了，这个操作只有服主能直接做。'
  if (action === 'say' && !perms.say) return '游戏内广播已经在设置里关掉了。'
  if (action === 'start' && !perms.playerStart) return '开服现在只有服主能做。'
  if (action === 'restart' && !perms.playerRestart) return '重启现在只有服主能做。'
  if (action === 'stop' && !perms.playerStop) return '停服只有服主能做。'
  if (action === 'gamemode' && !perms.gamemodeSwitch) return '切游戏模式现在只有服主能做。'
  if ((action === 'kubejs-backup' || action === 'kubejs-reload') && !perms.kubejsEdit) return 'KubeJS 相关操作已经在设置里关掉了。'
  return ''
}

/** 注入给 QQ 会话的能力清单（system prompt）。重点是天气：所有玩家都能用。 */
function renderAbilities() {
  return [
    '## 服务器操作能力（mc_server 工具，参数 action + actor）',
    '- 改天气：action=weather，arg 为 clear / rain / thunder（也可写 晴天 / 下雨 / 雷雨）。',
    '- 改时间：action=time，arg 为 day / noon / sunset / night / midnight / sunrise（也可写 白天 / 夜晚 / 中午 / 午夜…）。默认在设置里关闭；开启后规则和天气一样。',
    '  **所有玩家都能用，不要回复「只有服主能做」**。玩家需要先用 bind-player 绑定游戏名并且当前在游戏里；',
    '  服主/控制台直接执行。在线 ≤2 人直接生效，≥3 人时游戏内会广播投票（其他玩家输入 /vote yes）。',
    '- 其它常用 action：status、players、logs、say、gamemode、my-players、bind-player、vote-start / vote-approve / vote-status。',
  ].join('\n')
}

function renderPersona(persona) {
  const p = persona || {}
  const text = String(p.text || '').trim() || DEFAULT_PERSONA
  const who = String(p.name || '').trim()
  const lines = []
  if (who) lines.push('## 人设\n你在 QQ 里的名字是「' + who + '」。')
  lines.push(text)
  lines.push('说话像真人打字：短句、口语，别端着也别卖萌；问到服务器的事就照实答，不确定就说不确定。')
  return lines.join('\n')
}

// touch 2026-11-21T19:33:31.3335385+08:00
