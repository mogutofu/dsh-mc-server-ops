/**
 * 给 @tencent-connect/dsh-qqbot 的 inbound.js 打一个幂等抓取钩子：
 * 机器人收到 QQ 群/私聊消息时，把 scope + peerId（群 openid / 用户 openid）
 * 追加到 process.env.MC_OPS_QQ_KEYS_FILE 指向的文件里。
 *
 * 这样群服互通不需要用户手填群 openid：装好插件后在群里 @ 一次机器人，
 * 群 openid 就会被抓到，bridge 会自动采用（来源：captured）。
 *
 * 设计要点：
 * - 幂等：文件里已有 MARKER 就不再写；插件每次加载都会检查，qqbot 升级冲掉了会自动重打。
 * - 失败安全：任何异常都只返回结果，不抛错、不影响 qqbot 运行。
 * - 留备份：首次写前保存 inbound.js.mc-ops.bak。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MARKER = '[mc-ops capture hook]'

function listProfileDirs() {
  const dirs = []
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  try {
    for (const name of readdirSync(profiles)) dirs.push(join(profiles, name))
  } catch (error) {
    // ignore
  }
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (fromEnv) dirs.push(fromEnv)
  return dirs
}

function findQqbotInboundFiles() {
  const files = []
  for (const dir of listProfileDirs()) {
    const candidate = join(dir, 'node_modules', '@tencent-connect', 'dsh-qqbot', 'dist', 'transport', 'inbound.js')
    if (existsSync(candidate)) files.push(candidate)
  }
  return files
}

function ensureAppendFileSyncImport(source) {
  const m = /import\s*\{([^}]*)\}\s*from\s*'node:fs'/m.exec(source)
  if (m) {
    if (/\bappendFileSync\b/.test(m[1])) return source
    const names = m[1].trimEnd()
    return source.replace(m[0], 'import {' + names + ', appendFileSync } from \'node:fs\'')
  }
  // 没有 node:fs 具名导入：在第一条 import 后补一行
  const first = /^import[^\n]*\n/m.exec(source)
  if (!first) return source
  return source.slice(0, first.index + first[0].length) + 'import { appendFileSync } from \'node:fs\'\n' + source.slice(first.index + first[0].length)
}

function patchSource(source) {
  if (source.includes(MARKER)) return { changed: false, source, reason: 'already-patched' }
  const anchor = source.indexOf('const replyTarget = {')
  if (anchor === -1) return { changed: false, source, reason: 'anchor-not-found' }
  const end = source.indexOf('};', anchor)
  if (end === -1) return { changed: false, source, reason: 'anchor-end-not-found' }
  let next = ensureAppendFileSyncImport(source)
  const insertAt = next.indexOf('};', next.indexOf('const replyTarget = {')) + 2
  const block = [
    '',
    '    // ' + MARKER + ' 记录群/用户 openid，供群服互通自动发现目标群（dsh-mc-server-ops 写入，可删）',
    '    try {',
    '        const hookFile = process.env.MC_OPS_QQ_KEYS_FILE;',
    '        if (hookFile) appendFileSync(hookFile, new Date().toISOString() + \' \' + scope + \' \' + peerId + \'\\n\');',
    '    } catch { }',
    '',
  ].join('\n')
  next = next.slice(0, insertAt) + block + next.slice(insertAt)
  return { changed: true, source: next, reason: 'patched' }
}

/**
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {{ ok: boolean, patched: number, failed: number, files: string[], reason?: string }}
 */
export function ensureQqbotInboundHook(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const files = findQqbotInboundFiles()
  const result = { ok: files.length > 0, patched: 0, failed: 0, files, reason: '' }
  if (!files.length) {
    result.reason = '没有找到 @tencent-connect/dsh-qqbot（未安装 QQ 机器人插件？）'
    return result
  }
  for (const file of files) {
    try {
      const source = readFileSync(file, 'utf8')
      const patched = patchSource(source)
      if (!patched.changed) {
        log('qqbot 抓取钩子已存在：' + file)
        continue
      }
      if (patched.reason !== 'patched') {
        result.failed += 1
        log('qqbot 抓取钩子打不上（' + patched.reason + '）：' + file)
        continue
      }
      const backup = file + '.mc-ops.bak'
      if (!existsSync(backup)) copyFileSync(file, backup)
      writeFileSync(file, patched.source, 'utf8')
      result.patched += 1
      log('qqbot 抓取钩子已写入：' + file + '（重启 DSH / 重载 qqbot 后生效）')
    } catch (error) {
      result.failed += 1
      log('qqbot 抓取钩子写入失败：' + file + '：' + (error && error.message ? error.message : String(error)))
    }
  }
  return result
}
