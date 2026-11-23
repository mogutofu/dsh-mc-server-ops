import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Config, normalizeTimeArg, readPlaytimeMinutes, writeConfigBackup, readConfigBackup,
  restoreConfigIfReset, isDefaultPluginConfig, playtimeGateStateFor, whitelistEnabled, playerIsOwnerGameName, playtimeGateForQqFor,
} from '../index.js'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  if (!ok) failed++
}

// ── A. schema 默认值 ──
const c = Config({})
check('time.enabled 默认关闭', c.time.enabled === false, String(c.time.enabled))
check('time.approveNeed 默认 2', c.time.approveNeed === 2)
check('time.directThreshold 默认 2', c.time.directThreshold === 2)
check('time.timeoutSeconds 默认 60', c.time.timeoutSeconds === 60)
check('ai.playtimeGate 默认开启', c.ai.playtimeGate === true)
check('ai.minPlaytimeMinutes 默认 60', c.ai.minPlaytimeMinutes === 60)

// ── B. 时间参数 ──
check('day → 1000', normalizeTimeArg('day')?.ticks === 1000)
check('白天 → day', normalizeTimeArg('白天')?.key === 'day')
check('午夜 → 18000', normalizeTimeArg('午夜')?.ticks === 18000)
check('night → 13000', normalizeTimeArg('night')?.ticks === 13000)
check('数字 6000', normalizeTimeArg('6000')?.ticks === 6000)
check('超范围钳到 24000', normalizeTimeArg('99999')?.ticks === 24000)
check('乱填写 null', normalizeTimeArg('abc') === null)
check('空串 null', normalizeTimeArg('') === null)

// ── C. 游戏时长 ──
const dir = 'D:\\server\\tmp\\v071-test'
rmSync(dir, { recursive: true, force: true })
mkdirSync(join(dir, 'world', 'stats'), { recursive: true })
writeFileSync(join(dir, 'server.properties'), 'white-list=true\nenforce-whitelist=false\n', 'utf8')
writeFileSync(join(dir, 'usercache.json'), JSON.stringify([{ name: 'Steve', uuid: '11111111-1111-1111-1111-111111111111' }]), 'utf8')
const ticks = (minutes) => Math.round(minutes * 60 * 20)
writeFileSync(join(dir, 'world', 'stats', '11111111-1111-1111-1111-111111111111.json'), JSON.stringify({
  stats: { 'minecraft:custom': { 'minecraft:play_time': ticks(30) } },
}), 'utf8')

check('白名单读到 true', whitelistEnabled(dir) === true)
check('时长 30 分钟', Math.round(readPlaytimeMinutes('Steve', dir)) === 30, String(readPlaytimeMinutes('Steve', dir)))
check('30 分钟 < 60 → 拦截', playtimeGateStateFor('Steve', { minPlaytimeMinutes: 60 }, dir).gated === true)
check('门槛 20 → 放行', playtimeGateStateFor('Steve', { minPlaytimeMinutes: 20 }, dir).gated === false)
check('playtimeGate=false → 放行', playtimeGateStateFor('Steve', { playtimeGate: false, minPlaytimeMinutes: 60 }, dir).gated === false)
check('未绑定玩家 → 放行', playtimeGateStateFor('Nobody', { minPlaytimeMinutes: 60 }, dir).minutes === null)
const st = playtimeGateStateFor('Steve', { minPlaytimeMinutes: 60 }, dir)
check('返回实际分钟数', Math.round(st.minutes) === 30 && st.need === 60)

// 白名单关闭 → 不拦
writeFileSync(join(dir, 'server.properties'), 'white-list=false\n', 'utf8')
check('白名单关闭 → 放行', playtimeGateStateFor('Steve', { minPlaytimeMinutes: 60 }, dir).gated === false)

// 服主豁免：绑定到服主 QQ 的游戏名不看时长、不看白名单
writeFileSync(join(dir, 'server.properties'), 'white-list=true\n', 'utf8')
mkdirSync(join(dir, 'ops', 'data'), { recursive: true })
writeFileSync(join(dir, 'ops', 'data', 'owners.json'), JSON.stringify({ owners: ['QQ-OWNER'] }), 'utf8')
writeFileSync(join(dir, 'ops', 'data', 'bindings.json'), JSON.stringify([
  { qq: 'QQ-OWNER', name: 'Steve' },
  { qq: 'QQ-PLAYER', name: 'Alex' },
]), 'utf8')
writeFileSync(join(dir, 'usercache.json'), JSON.stringify([
  { name: 'Steve', uuid: '11111111-1111-1111-1111-111111111111' }, { name: 'Alex', uuid: '22222222-2222-2222-2222-222222222222' },
]), 'utf8')
writeFileSync(join(dir, 'world', 'stats', '22222222-2222-2222-2222-222222222222.json'), JSON.stringify({
  stats: { 'minecraft:custom': { 'minecraft:play_time': ticks(30) } },
}), 'utf8')
check('服主游戏名识别', playerIsOwnerGameName('Steve', dir) === true)
check('普通玩家不是服主', playerIsOwnerGameName('Alex', dir) === false)
check('服主 30 分钟也不拦', playtimeGateStateFor('Steve', { minPlaytimeMinutes: 60 }, dir).gated === false)
check('普通玩家 30 分钟照拦', playtimeGateStateFor('Alex', { minPlaytimeMinutes: 60 }, dir).gated === true)
check('免门槛名单里的名字放行', playtimeGateStateFor('Alex', { minPlaytimeMinutes: 60, trustedPlayers: ['alex'] }, dir).gated === false)
check('免门槛名单大小写无关', playtimeGateStateFor('Alex', { minPlaytimeMinutes: 60, trustedPlayers: ['ALEX'] }, dir).gated === false)
check('名单里没有就照拦', playtimeGateStateFor('Alex', { minPlaytimeMinutes: 60, trustedPlayers: ['Steve'] }, dir).gated === true)

// 未绑定玩家：请求里带 uuid 时按 uuid 算，没玩过就拦
writeFileSync(join(dir, 'world', 'stats', '33333333-3333-3333-3333-333333333333.json'), JSON.stringify({
  stats: { 'minecraft:custom': { 'minecraft:play_time': 0 } },
}), 'utf8')
check('未绑定 + uuid 且 0 分钟 → 拦截', playtimeGateStateFor('AltName', { minPlaytimeMinutes: 60 }, dir, '33333333-3333-3333-3333-333333333333').gated === true)
check('未绑定 + uuid 没统计文件 → 拦截', playtimeGateStateFor('AltName', { minPlaytimeMinutes: 60 }, dir, '44444444-4444-4444-4444-444444444444').gated === true)
writeFileSync(join(dir, 'world', 'stats', '77777777-7777-7777-7777-777777777777eran.json'), JSON.stringify({
  stats: { 'minecraft:custom': { 'minecraft:play_time': 200 * 60 * 20 } },
}), 'utf8')
check('未绑定 + uuid 200 分钟 → 放行', playtimeGateStateFor('Vet', { minPlaytimeMinutes: 60 }, dir, '77777777-7777-7777-7777-777777777777eran').gated === false)
check('未绑定 + 无 uuid 无名字 → 放行（认不出）', playtimeGateStateFor('', { minPlaytimeMinutes: 60 }, dir, '').gated === false)

// QQ 侧门槛：白名单开启时，未绑定也拦
writeFileSync(join(dir, 'server.properties'), 'white-list=true\n', 'utf8')
const cfg60 = { playtimeGate: true, minPlaytimeMinutes: 60 }
const qqUnbound = playtimeGateForQqFor('QQ-NOBODY', cfg60, dir)
check('QQ 未绑定 → 拦截', qqUnbound.gated === true && qqUnbound.reason === 'unbound', JSON.stringify(qqUnbound))
const qqOwner = playtimeGateForQqFor('QQ-OWNER', cfg60, dir)
check('QQ 服主 → 放行', qqOwner.gated === false, JSON.stringify(qqOwner))
const qqShort = playtimeGateForQqFor('QQ-PLAYER', cfg60, dir)
check('QQ 已绑定但时长不足 → 拦截', qqShort.gated === true && qqShort.reason === 'short', JSON.stringify(qqShort))
const qqOff = playtimeGateForQqFor('QQ-NOBODY', { playtimeGate: false }, dir)
check('关掉门槛 → 放行', qqOff.gated === false)
writeFileSync(join(dir, 'server.properties'), 'white-list=false\n', 'utf8')
check('白名单关掉 → 放行', playtimeGateForQqFor('QQ-NOBODY', cfg60, dir).gated === false)
check('门槛设 0 就是关掉（不被当成 60）', playtimeGateStateFor('Alex', { minPlaytimeMinutes: 0 }, dir).gated === false)
check('QQ 门槛 0 分钟也放行', playtimeGateForQqFor('QQ-PLAYER', { minPlaytimeMinutes: 0 }, dir).gated === false)
writeFileSync(join(dir, 'server.properties'), 'white-list=true\n', 'utf8')

// ── D. 配置备份 ──
const bdir = 'D:\\server\\tmp\\v071-cfg'
rmSync(bdir, { recursive: true, force: true })
mkdirSync(join(bdir, 'ops', 'data'), { recursive: true })
check('没有备份时读到 null', readConfigBackup(bdir) === null)
check('默认配置判定', isDefaultPluginConfig(Config({})) === true)
check('非默认配置判定', isDefaultPluginConfig({ time: { enabled: true } }) === false)

writeConfigBackup(bdir, { time: { enabled: true }, ai: { minPlaytimeMinutes: 120 } })
const backup = readConfigBackup(bdir)
check('备份写入并读回', backup && backup.time.enabled === true && backup.ai.minPlaytimeMinutes === 120, JSON.stringify(backup))

const restored = restoreConfigIfReset(bdir, Config({}))
check('配置被重置时用备份恢复', restored.time.enabled === true && restored.ai.minPlaytimeMinutes === 120, JSON.stringify(restored.time))

const kept = restoreConfigIfReset(bdir, { time: { enabled: false }, ai: { minPlaytimeMinutes: 15 } })
check('用户自己改过就不动', kept.time.enabled === false && kept.ai.minPlaytimeMinutes === 15)

rmSync(dir, { recursive: true, force: true })
rmSync(bdir, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
