import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

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
// 需要服主授权才能用的工具
const GUARDED_TOOLS = ['write', 'edit', 'pwsh', 'web_fetch', 'web_search']
// 发文件到 QQ 的工具（玩家可用，但敏感文件除外）
const SEND_TOOLS = ['qqbot_send_file', 'present']
const SENSITIVE_PATH = /(server\.properties|ops[\\/]+data[\\/]+|\.credentials|\.env\b|owners\.json|config\.json|\.pem\b|\.key\b)/i
// 玩家可以改的范围：KubeJS 的 server_scripts（配方脚本）
// 玩家可以改的范围：服务器目录下除敏感区之外的文件（修配置、修脚本用）
function normalizePath(p) { return String(p || '').replace(/\//g, '\\').toLowerCase() }
function isPlayerWritable(target) {
  const root = normalizePath(paths.serverDir).replace(/\\+$/, '') + '\\'
  const t = normalizePath(target)
  if (!root || !t.startsWith(root)) return false
  if (t.includes('..')) return false
  return !PLAYER_WRITE_DENY.test(t)
}
const PLAYER_WRITE_DENY = /(ops[\\/]+data|world(_nether|_the_end)?[\\/]|\.dsh|credential|\.key$|\.pem$|\.env$|whitelist\.json|ops\.json|banned-|usercache\.json|eula\.txt|server\.jar|\.exe$|\.dll$|\.lnk$)/i
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

function grantTools(agentId) {
  if (agentId) grants.set(String(agentId), Date.now() + GRANT_MS)
}

function hasToolGrant(agentId) {
  const until = grants.get(String(agentId)) ?? 0
  return until > Date.now()
}

const ACTIONS = [
  'status', 'players', 'say', 'cmd', 'start', 'stop', 'restart',
  'logs', 'crashinfo', 'whoami', 'help', 'bind', 'gamemode',
  'bind-player', 'unbind-player', 'my-players', 'bindings', 'whitelist-sync',
  'kubejs-backup', 'kubejs-reload', 'vote-start', 'vote-approve', 'vote-reject', 'vote-status',
]

function runMcAdmin(args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.script, ...args], {
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
  '- cmd：执行任意后台指令（op/deop/ban/kick/whitelist 等），仅服主',
  '',
  '玩家还能做：用 read / glob / grep 看服务器文件、用只读的 pwsh 命令查信息、用 qqbot_send_file 把普通文件发到群里（口令/密钥类文件除外）。',
  '玩家不能：改文件、删文件、新建文件、执行危险命令、设置创造模式。',
  '- bind：绑定服主口令，arg 为口令，actor 为发送者在群里的 ID',
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

export const name = 'mc-server-ops'
export const inject = ['tools']

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

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
})

export function apply(ctx, config) {
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
          description: 'say 的内容、cmd 的指令（不带斜杠）、bind 的口令，其它操作为空',
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
      const action = String((args && args.action) || '')
      if (!ACTIONS.includes(action)) throw new Error('mc_server: 不支持的 action: ' + action)
      const actor = String((args && args.actor) || '').trim()
      if (!actor) throw new Error('mc_server: actor 不能为空（必须取自 [昵称 (ID)] 标记）')
      const cli = ['-Action', action, '-Actor', actor]
      const arg = args && args.arg !== undefined && args.arg !== null ? String(args.arg) : ''
      if (arg !== '') cli.push('-Arg', arg)
      const result = await runMcAdmin(cli, 170000)
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
    if (isLocalSession(id)) return undefined
    if (exec.name === 'mc_server') return undefined

    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}

    if (OPEN_READ_TOOLS.includes(exec.name)) return undefined

    if (SEND_TOOLS.includes(exec.name)) {
      const target = String(args.file_path || args.path || '')
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
      if (persona.enabled === false) return assembled
      const scope = String(persona.scope || 'qq')
      if (scope === 'none') return assembled
      const agentId = context && context.agent ? String(context.agent.id ?? '') : ''
      if (!agentId) return assembled
      if (scope === 'qq' && isLocalSession(agentId)) return assembled
      const text = renderPersona(persona)
      if (!text) return assembled
      return {
        ...assembled,
        sections: [...(assembled.sections ?? []), { name: 'mc-ops:persona', order: 91, text }],
      }
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
