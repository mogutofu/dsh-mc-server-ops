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
 */
import { createConnection } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs'
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

function findJava(serverDir) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq java.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      const m = /"java\.exe","(\d+)"/i.exec(out)
      if (m) return Number(m[1])
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
  throw new Error('未知 action: ' + action)
}

main().catch((err) => {
  process.stdout.write(String(err && err.message ? err.message : err))
  process.exitCode = 1
})
