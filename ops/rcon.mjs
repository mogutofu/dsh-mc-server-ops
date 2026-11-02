#!/usr/bin/env node
/**
 * 跨平台运维核心：RCON、进程探测、日志、状态汇总。
 *
 * 只依赖 Node 内置模块，Windows / Linux / macOS 都能跑。
 * 用法：
 *   node rcon.mjs --dir <服务器目录> --action status
 *   node rcon.mjs --dir <服务器目录> --action players
 *   node rcon.mjs --dir <服务器目录> --action logs --arg 50
 *   node rcon.mjs --dir <服务器目录> --action say --arg "hello"
 *   node rcon.mjs --dir <服务器目录> --action cmd --arg "list"
 *   node rcon.mjs --dir <服务器目录> --action start|stop|restart [--dry-run]
 */
import { createConnection } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function parseArgs(argv) {
  const out = { dir: process.cwd(), action: 'status', arg: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--action') out.action = argv[++i]
    else if (a === '--arg') out.arg = argv[++i]
  }
  return out
}

function readProperties(dir) {
  const file = join(dir, 'server.properties')
  const map = {}
  if (!existsSync(file)) return map
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([^=#][^=]*)=(.*)$/.exec(line)
    if (m) map[m[1].trim()] = m[2]
  }
  return map
}

function rconCall(port, password, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buf = Buffer.alloc(0)
    let authed = false
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { }
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('RCON 超时')), timeoutMs)
    const send = (id, type, body) => {
      const payload = Buffer.from(body, 'utf8')
      const size = 4 + 4 + payload.length + 2
      const pkt = Buffer.alloc(4 + size)
      pkt.writeInt32LE(size, 0)
      pkt.writeInt32LE(id, 4)
      pkt.writeInt32LE(type, 8)
      payload.copy(pkt, 12)
      pkt.writeInt16LE(0, pkt.length - 2)
      socket.write(pkt)
    }
    const body = () => {
      const pkt = buf.subarray(0, 4096)
      const len = pkt.readInt32LE(0)
      const start = 12
      const end = 4 + len - 2
      return { body: buf.subarray(start, end).toString('utf8'), rest: buf.subarray(4 + len) }
    }
    socket.on('error', (e) => { clearTimeout(timer); finish(e) })
    socket.on('connect', () => send(1, 3, password))
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const results = []
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0)
        if (buf.length < len + 4) break
        const id = buf.readInt32LE(4)
        const type = buf.readInt32LE(8)
        const text = buf.subarray(12, 4 + len - 2).toString('utf8')
        buf = buf.subarray(4 + len)
        if (type === 2 && id === -1) return clearTimeout(timer), finish(new Error('RCON 密码不对'))
        if (!authed && id === 1) {
          authed = true
          send(2, 2, command)
          continue
        }
        if (authed && type === 0) results.push(text)
      }
      if (results.length) {
        clearTimeout(timer)
        finish(null, results.join('\n'))
      }
    })
  })
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function looksLikeJava(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      return /java\.exe/i.test(out)
    }
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('java')
  } catch { return false }
}

function findJava(serverDir) {
  // 1) 先信 pid 文件（我们自己写的那条），能避免多开时认错进程
  try {
    const f = join(serverDir, 'ops', 'data', 'server.pid')
    if (existsSync(f)) {
      const pid = Number(readFileSync(f, 'utf8').trim())
      if (pid > 0 && pidAlive(pid) && looksLikeJava(pid)) return pid
    }
  } catch { }
  // 2) 按命令行匹配服务器目录
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('wmic', ['process', 'where', "name='java.exe'", 'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8' })
      const want = serverDir.replace(/\\+$/, '').toLowerCase()
      for (const line of out.split(/\r?\n/)) {
        if (!line || !/java\.exe/i.test(line)) continue
        const m = /,(\d+)\s*$/.exec(line)
        if (!m) continue
        if (line.toLowerCase().includes(want)) return Number(m[1])
      }
      return null
    }
    const entries = readdirSync('/proc').filter((n) => /^\d+$/.test(n))
    for (const pid of entries) {
      let cmd = ''
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }
      if (!cmd.includes('java')) continue
      if (!cmd.includes(serverDir.replace(/\/+$/, ''))) continue
      return Number(pid)
    }
  } catch { }
  return null
}
function processInfo(pid) {
  const info = { pid, rssKB: null, uptimeSec: null }
  if (!pid) return info
  try {
    if (process.platform === 'win32') return info
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const m = /VmRSS:\s+(\d+) kB/.exec(status)
    if (m) info.rssKB = Number(m[1])
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')
    const startTicks = Number(stat[21])
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
    const hz = 100
    info.uptimeSec = Math.max(0, Math.floor(uptime - startTicks / hz))
  } catch { }
  return info
}

function dirSizeBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let list
    try { list = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of list) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        try { total += statSync(p).size } catch { }
      }
    }
  }
  return total
}

function diskFree(dir) {
  try {
    const st = statfsSync(dir)
    return st.bsize * st.bavail
  } catch { }
  return null
}

function formatUptime(sec) {
  if (!sec) return '-'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return (d > 0 ? d + ' 天 ' : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
}

async function tps(rcon) {
  const probes = [
    ['forge tps', /Mean TPS:\s*([\d.]+)/],
    ['tps', /TPS[^\d]*([\d.]+)/],
    ['spark tps', /TPS[^\d]*([\d.]+)/],
    ['carpet tps', /TPS[^\d]*([\d.]+)/],
  ]
  for (const [cmd, re] of probes) {
    try {
      const out = await rcon(cmd)
      const m = re.exec(out || '')
      if (m) return Number(m[1])
    } catch { }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function dataDir(dir) { return join(dir, 'ops', 'data') }
function pidFile(dir) { return join(dataDir(dir), 'server.pid') }

function walkFind(root, name) {
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    let list
    try { list = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of list) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === name) return p
    }
  }
  return null
}

function javaExecutable(dir) {
  const p = join(dir, 'java', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  return existsSync(p) ? p : 'java'
}

/** 和服务端类型无关的启动目标探测：forge 参数文件 → loader jar → 根目录 jar → 启动脚本 */
function detectLaunch(dir) {
  const isWin = process.platform === 'win32'
  const javaExe = javaExecutable(dir)
  const jvm = existsSync(join(dir, 'user_jvm_args.txt')) ? ['@user_jvm_args.txt'] : []
  const lib = join(dir, 'libraries')
  if (existsSync(lib)) {
    const found = walkFind(lib, isWin ? 'win_args.txt' : 'unix_args.txt')
    if (found) {
      const rel = '@' + found.slice(dir.length + 1).split('\\').join('/')
      return { javaExe, args: [...jvm, rel, 'nogui'], desc: 'forge args: ' + rel }
    }
  }
  for (const name of ['fabric-server-launch.jar', 'fabric-server-launcher.jar', 'quilt-server-launch.jar']) {
    const p = join(dir, name)
    if (existsSync(p)) return { javaExe, args: [...jvm, '-jar', p, 'nogui'], desc: 'jar: ' + name }
  }
  try {
    const jars = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.jar') && !/installer|shim|sources|javadoc/i.test(n))
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    if (jars.length) return { javaExe, args: [...jvm, '-jar', join(dir, jars[0].n), 'nogui'], desc: 'jar: ' + jars[0].n }
  } catch { }
  const script = isWin ? 'run.bat' : 'run.sh'
  if (existsSync(join(dir, script))) return { javaExe: script, args: [], desc: script, isScript: true }
  return null
}

async function doStart(dir, dryRun) {
  const running = findJava(dir)
  if (running) return `服务器已经在运行（pid ${running}）`
  const launch = detectLaunch(dir)
  if (!launch) throw new Error('没有找到启动目标：libraries 参数文件、*.jar、run.sh 都不存在')
  if (dryRun) return '[dry-run] ' + launch.javaExe + ' ' + launch.args.join(' ')
  mkdirSync(join(dir, 'logs'), { recursive: true })
  mkdirSync(dataDir(dir), { recursive: true })
  if (launch.isScript) {
    const child = spawn(launch.javaExe, [], { cwd: dir, detached: true, stdio: 'ignore', shell: true })
    child.unref()
    writeFileSync(pidFile(dir), String(child.pid), 'utf8')
    return `已通过 ${launch.desc} 启动（pid ${child.pid}）`
  }
  const logFd = openSync(join(dir, 'logs', 'console.log'), 'a')
  const child = spawn(launch.javaExe, launch.args, { cwd: dir, detached: true, stdio: ['ignore', logFd, logFd] })
  child.unref()
  writeFileSync(pidFile(dir), String(child.pid), 'utf8')
  return `已启动（pid ${child.pid}，${launch.desc}），加载约 40 秒`
}

async function doStop(dir, call, waitSec = 90) {
  const pid = findJava(dir)
  if (!pid) return '服务器没在运行'
  let asked = false
  try { await call('stop', 3000); asked = true } catch { }
  const deadline = Date.now() + waitSec * 1000
  while (Date.now() < deadline) {
    await sleep(1000)
    if (!findJava(dir)) return asked ? '已停止（RCON stop）' : '已停止'
  }
  // 强杀之前再确认一次：这个 pid 必须仍然属于本服务器目录，防止误杀别的 Java 进程
  if (findJava(dir) !== pid) return '已停止'
  try { process.kill(pid) } catch { }
  await sleep(1500)
  return findJava(dir) ? '已强制结束进程（超时）' : '已停止'
}

async function main() {
  const { dir, action, arg } = parseArgs(process.argv.slice(2))
  const props = readProperties(dir)
  const port = Number(props['rcon.port'] || 25575)
  const password = props['rcon.password'] || ''
  const enabled = String(props['enable-rcon'] || '').toLowerCase() === 'true'
  const call = (cmd, ms = 4000) => rconCall(port, password, cmd, ms)

  if (action === 'players') {
    if (!enabled) throw new Error('server.properties 里没有开启 RCON')
    process.stdout.write(await call('list'))
    return
  }
  if (action === 'say' || action === 'cmd') {
    if (!enabled) throw new Error('server.properties 里没有开启 RCON')
    const text = action === 'say' ? 'say ' + arg : arg
    process.stdout.write(await call(text, 8000))
    return
  }
  if (action === 'logs') {
    const n = Math.max(1, Number(arg) || 40)
    const file = join(dir, 'logs', 'latest.log')
    if (!existsSync(file)) { process.stdout.write('(没有日志文件)'); return }
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !/RCON (Client|Listener)/.test(l))
    process.stdout.write(lines.slice(-n).join('\n'))
    return
  }
  if (action === 'status') {
    const pid = findJava(dir)
    const info = processInfo(pid)
    const running = !!pid
    let health = 'stopped'
    let online = '-'
    let tpsValue = null
    if (running) {
      let rconOk = false
      try { await call('list', 3000); rconOk = true } catch { }
      if (!rconOk) {
        health = info.uptimeSec !== null && info.uptimeSec < 180 ? 'booting' : 'unresponsive'
      } else {
        tpsValue = await tps(call)
        health = tpsValue !== null && tpsValue < 3 ? 'lagging' : 'healthy'
        try {
          const list = await call('list')
          const m = /There are (\d+) of a max of (\d+) players online/.exec(list || '')
          if (m) online = m[1] + '/' + m[2]
        } catch { }
      }
    }
    const healthText = { stopped: '未运行', booting: '启动中', healthy: '正常', lagging: '严重卡顿', unresponsive: '无响应（假死）' }[health]
    const mem = info.rssKB ? (info.rssKB / 1024).toFixed(0) + ' MB' : '-'
    const free = diskFree(dir)
    let world = '-'
    const worldDir = join(dir, 'world')
    if (existsSync(worldDir)) {
      try { world = (dirSizeBytes(worldDir) / 1024 / 1024).toFixed(0) + ' MB' } catch { }
    }
    process.stdout.write([
      `运行: ${running ? 'yes' : 'no'}  健康: ${healthText}  pid: ${pid || '-'}  在线: ${online}`,
      `内存: ${mem}  运行时长: ${formatUptime(info.uptimeSec)}`,
      `TPS: ${tpsValue === null ? '-' : tpsValue.toFixed(3)}`,
      `地图: ${world}  磁盘剩余: ${free === null ? '-' : (free / 1024 / 1024 / 1024).toFixed(1) + ' GB'}`,
      `难度: ${props['difficulty'] || '-'}  端口: ${props['server-port'] || '-'}`,
    ].join('\n'))
    return
  }
  if (action === 'start') {
    process.stdout.write(await doStart(dir, process.argv.includes('--dry-run')))
    return
  }
  if (action === 'stop') {
    process.stdout.write(await doStop(dir, call))
    return
  }
  if (action === 'restart') {
    const stopped = await doStop(dir, call)
    const started = await doStart(dir, process.argv.includes('--dry-run'))
    process.stdout.write(stopped + '；' + started)
    return
  }
  throw new Error('未知 action: ' + action)
}

main().catch((err) => {
  process.stdout.write(String(err && err.message ? err.message : err))
  process.exitCode = 1
})
