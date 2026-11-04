/**
 * 极简 RCON 探测：只为了拿「当前在线玩家名单」。
 *
 * 单独一个文件是为了避免 import rcon.mjs —— 那个文件在被 import 时会执行 main()。
 */
import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function readProperties(dir) {
  const map = {}
  try {
    const file = join(dir, 'server.properties')
    if (!existsSync(file)) return map
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([^=#][^=]*)=(.*)$/.exec(line)
      if (m) map[m[1].trim()] = m[2]
    }
  } catch { /* 读不到就当没有 */ }
  return map
}

function packet(id, type, body) {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  buf.writeInt16LE(0, 12 + payload.length)
  return buf
}

export function rconCommand(port, password, command, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buf = Buffer.alloc(0)
    let authed = false
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('RCON 超时')) }, timeoutMs)
    const done = (err, value) => {
      clearTimeout(timer)
      try { socket.destroy() } catch { }
      if (err) reject(err); else resolve(value)
    }
    socket.on('connect', () => socket.write(packet(1, 3, password)))
    socket.on('error', (e) => done(e))
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 12) {
        const len = buf.readInt32LE(0)
        if (buf.length < len + 4) break
        const id = buf.readInt32LE(4)
        const type = buf.readInt32LE(8)
        const body = buf.subarray(12, len + 2).toString('utf8')
        buf = buf.subarray(len + 4)
        if (type === 2 && id === -1) return done(new Error('RCON 密码不对'))
        if (!authed) {
          if (type !== 2) continue
          authed = true
          socket.write(packet(2, 2, command))
          continue
        }
        return done(null, body)
      }
    })
  })
}

/** @returns {Promise<string[]>} 在线玩家名 */
export async function probePlayers(serverDir) {
  const props = readProperties(serverDir)
  const enabled = String(props['enable-rcon'] || '').toLowerCase() === 'true'
  if (!enabled) return []
  const port = Number(props['rcon.port'] || 25575)
  const password = props['rcon.password'] || ''
  if (!password) return []
  const out = await rconCommand(port, password, 'list', 4000)
  // "There are 1 of a max of 20 players online: Steve, Alex"
  const idx = out.indexOf(':')
  if (idx < 0) return []
  return out.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean)
}

/** 直接发一条指令（给 QQ→游戏 的 P1 预留） */
export async function rconSay(serverDir, command) {
  const props = readProperties(serverDir)
  const port = Number(props['rcon.port'] || 25575)
  const password = props['rcon.password'] || ''
  if (!password) throw new Error('server.properties 里没有 rcon.password')
  return rconCommand(port, password, command, 5000)
}
