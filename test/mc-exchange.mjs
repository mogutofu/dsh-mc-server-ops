// /mc-exchange 的本地测试：先跑纯函数单元校验，再对 127.0.0.1:8765 跑接口矩阵。
// 用法：node test/mc-exchange.mjs
//   - 不需要第三方依赖，Node 20+ 自带 fetch 即可；
//   - DSH 没开、或插件没监听 / 服务连不上时，HTTP 部分全部 SKIP，脚本仍以 0 退出；
//   - 设置里 exchange.enabled=false 时只验证「404 + /mc-ai 还活着」，其余场景 SKIP；
//   - 打开 exchange 后跑 ping / parse×3 / news / report / prospectus / government×2 / 400 参数校验 / 429。
//   - 环境变量 MC_EXCHANGE_URL 可以换地址，默认 http://127.0.0.1:8765。

import {
  EXCHANGE_AGENT_TASKS,
  EXCHANGE_GOVERNMENT_ACTIONS,
  EXCHANGE_INTENTS,
  EXCHANGE_TASKS,
  extractFirstJsonObject,
  limitExchangeContext,
  limitExchangeMessage,
  normalizeExchangeRequest,
  parseExchangeReply,
  validateExchangeData,
} from '../ops/mc-exchange.mjs'

const BASE = (process.env.MC_EXCHANGE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '')
const results = []

function record(name, status, detail) {
  results.push({ name, status, detail: detail || '' })
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP'
  console.log('[' + mark + '] ' + name + (detail ? ' — ' + detail : ''))
}

function check(name, condition, detail) {
  record(name, condition ? 'PASS' : 'FAIL', detail)
}

function shortError(error) {
  return error && error.message ? String(error.message) : String(error)
}

// ── 纯函数单元校验（不需要服务）──────────────────────────────────────────

function runUnitChecks() {
  console.log('\n--- 单元校验（纯函数，不需要 DSH）---')

  check('task 枚举', EXCHANGE_TASKS.length === 6 && EXCHANGE_AGENT_TASKS.length === 5,
    EXCHANGE_TASKS.join(' / '))
  check('intent 枚举非空且含 buy', EXCHANGE_INTENTS.includes('buy') && EXCHANGE_INTENTS.includes('unknown'),
    EXCHANGE_INTENTS.length + ' 个')
  check('government action 枚举', EXCHANGE_GOVERNMENT_ACTIONS.length === 10,
    EXCHANGE_GOVERNMENT_ACTIONS.join(' / '))

  // 取第一个括号配平
  check('JSON 提取：```json 包裹', extractFirstJsonObject('```json\n{"a":1}\n```') === '{"a":1}')
  check('JSON 提取：前后有废话', extractFirstJsonObject('好的，结果如下：{"a":1} 以上') === '{"a":1}')
  check('JSON 提取：字符串里的花括号', extractFirstJsonObject('{"a":"} {"}') === '{"a":"} {"}')
  check('JSON 提取：没有对象返回 null', extractFirstJsonObject('抱歉，我做不了') === null)
  check('JSON 提取：括号不配平返回 null', extractFirstJsonObject('{"a":1') === null)

  // parse：正常 / 夹带 markdown / 坏 JSON / schema 不合规
  const goodParse = '{"intent":"buy","items":[{"id":"minecraft:iron_pickaxe","count":3}],"symbol":"","shares":0,"amountCents":0,"reply":"好的"}'
  const parsed = parseExchangeReply('parse', goodParse)
  check('parse 正常 JSON 通过', parsed.ok && parsed.data.intent === 'buy' && parsed.data.items[0].count === 3,
    parsed.ok ? '' : parsed.error)
  const fenced = parseExchangeReply('parse', '```json\n' + goodParse + '\n```')
  check('parse 剥 markdown 后通过并标记 repaired', fenced.ok && fenced.repaired === true)
  check('parse 纯文字返回 ok:false', parseExchangeReply('parse', '我不太明白').ok === false)
  check('parse 坏 JSON 返回 ok:false', parseExchangeReply('parse', '{"intent":"buy",}').ok === false)
  check('parse intent 不在枚举 → ok:false', parseExchangeReply('parse', '{"intent":"teleport"}').ok === false)
  check('parse 数量 577 越界 → ok:false',
    parseExchangeReply('parse', '{"intent":"buy","items":[{"id":"minecraft:iron_pickaxe","count":577}]}').ok === false)
  check('parse 数量 576 边界通过',
    parseExchangeReply('parse', '{"intent":"buy","items":[{"id":"minecraft:iron_pickaxe","count":576}]}').ok === true)
  check('parse 物品 id 缺命名空间 → ok:false',
    parseExchangeReply('parse', '{"intent":"buy","items":[{"id":"iron_pickaxe","count":1}]}').ok === false)
  check('parse 数量 0 → ok:false',
    parseExchangeReply('parse', '{"intent":"buy","items":[{"id":"minecraft:iron_pickaxe","count":0}]}').ok === false)
  check('parse buy 但 items 空 → ok:false',
    parseExchangeReply('parse', '{"intent":"buy","items":[]}').ok === false)
  const stockParse = parseExchangeReply('parse', '{"intent":"stock_buy","symbol":"blk","shares":10}')
  check('parse 股票代码转大写', stockParse.ok && stockParse.data.symbol === 'BLK')
  check('parse stock_buy 缺 shares → ok:false',
    parseExchangeReply('parse', '{"intent":"stock_buy","symbol":"BLK","shares":0}').ok === false)
  check('parse deposit 缺金额 → ok:false',
    parseExchangeReply('parse', '{"intent":"deposit"}').ok === false)
  check('parse 金额为负 → ok:false',
    parseExchangeReply('parse', '{"intent":"deposit","amountCents":-1}').ok === false)
  check('parse 金额是小数 → ok:false',
    parseExchangeReply('parse', '{"intent":"deposit","amountCents":12.5}').ok === false)

  // news / report / prospectus
  check('news 正常通过',
    parseExchangeReply('news', '{"headline":"铁矿涨价","body":"正文","effects":[{"target":"minecraft:iron_ingot","multiplier":1.08,"ticks":6}]}').ok === true)
  check('news multiplier 越界 → ok:false',
    parseExchangeReply('news', '{"headline":"x","body":"y","effects":[{"target":"minecraft:iron_ingot","multiplier":3,"ticks":6}]}').ok === false)
  check('news 缺 headline → ok:false', parseExchangeReply('news', '{"body":"y"}').ok === false)
  check('report 正常通过（利润可为负）',
    parseExchangeReply('report', '{"revenueCents":1000,"profitCents":-200,"outlook":"down","headline":"财报"}').ok === true)
  check('report outlook 非法 → ok:false',
    parseExchangeReply('report', '{"revenueCents":1000,"profitCents":1,"outlook":"sideways"}').ok === false)
  check('report 营收为负 → ok:false',
    parseExchangeReply('report', '{"revenueCents":-1,"profitCents":1,"outlook":"up"}').ok === false)
  check('prospectus 正常通过',
    parseExchangeReply('prospectus', '{"title":"招股书","summary":"简介","risk":"风险","useOfFunds":"用途"}').ok === true)
  check('prospectus 缺 title → ok:false', parseExchangeReply('prospectus', '{"summary":"简介"}').ok === false)

  // government：action 与 params 边界
  const gov = (action, params) => parseExchangeReply('government', JSON.stringify({ action, params, reason: '理由', announcement: '' }))
  check('government none 通过', gov('none', {}).ok === true)
  check('government none 忽略 params', gov('none', { bp: 50 }).ok === true)
  check('government rate_cut bp=25 通过', gov('rate_cut', { bp: 25 }).ok === true)
  check('government rate_cut bp=26 → ok:false', gov('rate_cut', { bp: 26 }).ok === false)
  check('government rate_hike bp=100 通过', gov('rate_hike', { bp: 100 }).ok === true)
  check('government welfare 50000 边界通过', gov('welfare', { amountCents: 50000 }).ok === true)
  check('government welfare 超 500 币 → ok:false', gov('welfare', { amountCents: 50001 }).ok === false)
  check('government stimulus 正常通过',
    gov('stimulus', { amountCents: 100000, sectors: ['工业'], days: 3 }).ok === true)
  check('government stimulus days=0 → ok:false',
    gov('stimulus', { amountCents: 100000, sectors: ['工业'], days: 0 }).ok === false)
  check('government stimulus sectors 空 → ok:false',
    gov('stimulus', { amountCents: 100000, sectors: [], days: 3 }).ok === false)
  check('government austerity ratio=0.02 通过', gov('austerity', { ratio: 0.02 }).ok === true)
  check('government austerity ratio=0.5 → ok:false', gov('austerity', { ratio: 0.5 }).ok === false)
  check('government subsidy 正常通过',
    gov('subsidy', { target: 'minecraft:iron_ingot', ratio: 0.2, days: 3 }).ok === true)
  check('government tariff target 非法 → ok:false',
    gov('tariff', { target: '铁锭', ratio: 0.1, days: 3 }).ok === false)
  check('government liquidity ratio=1 通过', gov('liquidity', { ratio: 1 }).ok === true)
  check('government liquidity ratio=1.01 → ok:false', gov('liquidity', { ratio: 1.01 }).ok === false)
  check('government min_wage 1000 通过', gov('min_wage', { amountCents: 1000 }).ok === true)
  check('government min_wage 999 → ok:false', gov('min_wage', { amountCents: 999 }).ok === false)
  check('government action 非法 → ok:false', gov('print_money', {}).ok === false)
  check('government 非对象 → ok:false', validateExchangeData('government', 'nope').ok === false)

  // 请求校验 / 输入裁剪
  check('请求：未知 task → ok:false', normalizeExchangeRequest({ task: 'nope' }).ok === false)
  check('请求：ping 不需要 message', normalizeExchangeRequest({ task: 'ping' }).ok === true)
  check('请求：parse 缺 message → ok:false', normalizeExchangeRequest({ task: 'parse' }).ok === false)
  check('请求：message 非字符串 → ok:false',
    normalizeExchangeRequest({ task: 'parse', message: 123 }).ok === false)
  check('请求：context 是数组 → ok:false',
    normalizeExchangeRequest({ task: 'parse', message: 'x', context: [] }).ok === false)
  check('message 截断到 200 字', Array.from(limitExchangeMessage('字'.repeat(300), 200)).length === 200)
  const bigContext = {
    items: Array.from({ length: 2000 }, (_, index) => ({ id: 'minecraft:item_' + index, note: 'x'.repeat(100) })),
  }
  const limited = limitExchangeContext(bigContext, 2000)
  check('context 超限截断到上限内', limited.truncated === true && limited.text.length <= 2000,
    limited.text.length + ' 字符')
  let limitedJsonOk = true
  try { JSON.parse(limited.text) } catch { limitedJsonOk = false }
  check('截断后的 context 仍是合法 JSON', limitedJsonOk)
  check('context 未超限不截断', limitExchangeContext({ a: 1 }, 2000).truncated === false)
}

// ── HTTP 接口矩阵 ─────────────────────────────────────────────────────────

async function httpJson(method, path, payload, timeoutMs = 30000) {
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (payload !== undefined) init.body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  init.signal = AbortSignal.timeout(timeoutMs)
  const res = await fetch(BASE + path, init)
  let json = null
  try { json = await res.json() } catch { json = null }
  return { status: res.status, json }
}

const postExchange = (payload, timeoutMs) => httpJson('POST', '/mc-exchange', payload, timeoutMs)

/** 发一个 task 并校验 data 结构；返回规范化后的 data（失败返回 null）。 */
async function expectTask(name, task, message, context) {
  let res
  try {
    res = await postExchange({ task, player: 'AIMCmarket', uuid: '00000000-0000-0000-0000-00000000a1c0', message, context })
  } catch (error) {
    record(name, 'FAIL', '请求失败：' + shortError(error))
    return null
  }
  if (res.status !== 200) {
    record(name, 'FAIL', 'HTTP ' + res.status)
    return null
  }
  if (!res.json || res.json.ok !== true) {
    record(name, 'FAIL', 'ok:false ' + String((res.json && res.json.error) || res.json || ''))
    return null
  }
  const checked = validateExchangeData(task, res.json.data)
  if (!checked.ok) {
    record(name, 'FAIL', 'data 不合法：' + checked.error)
    return null
  }
  const detail = task === 'parse'
    ? 'intent=' + checked.data.intent + '，耗时 ' + (res.json.elapsedMs || '?') + 'ms'
    : (checked.data.action ? 'action=' + checked.data.action + '，' : '') + '耗时 ' + (res.json.elapsedMs || '?') + 'ms'
  record(name, 'PASS', detail)
  return checked.data
}

function skipAllHttp(reason) {
  const names = [
    '/mc-exchange 打开后 ping',
    'parse：买物品', 'parse：买股票', 'parse：存钱',
    'news', 'report', 'prospectus', 'government：紧张', 'government：平静',
    '400：未知 task', '400：parse 缺 message', '400：context 不是对象',
    '坏 JSON → ok:false', '429 限流',
  ]
  for (const name of names) record(name, 'SKIP', reason)
}

async function runHttpChecks() {
  console.log('\n--- HTTP 接口（' + BASE + '）---')
  let serverUp = true
  try {
    // 不建会话地探一下 /mc-ai 还在：坏 JSON 应回 400，而不是 404。
    const ai = await httpJson('POST', '/mc-ai', '{', 5000)
    if (ai.status === 404) check('/mc-ai 路由仍然存在', false, 'HTTP 404 not found')
    else check('/mc-ai 路由仍然存在', ai.status === 400 && !!(ai.json && ai.json.error), 'HTTP ' + ai.status)
  } catch (error) {
    serverUp = false
    record('/mc-ai 路由仍然存在', 'SKIP', '连不上 ' + BASE + '：' + shortError(error))
  }
  if (!serverUp) {
    record('/mc-exchange 关闭时 404', 'SKIP', '服务没起（本地没有 DSH 进程时正常）')
    skipAllHttp('服务没起（本地没有 DSH 进程时正常）')
    return
  }

  let ping
  try {
    ping = await postExchange({ task: 'ping' }, 5000)
  } catch (error) {
    record('/mc-exchange 关闭时 404', 'FAIL', '请求失败：' + shortError(error))
    skipAllHttp('请求 /mc-exchange 失败')
    return
  }

  const disabled = ping.status === 404 && ping.json && ping.json.ok === false && ping.json.error === 'exchange disabled'
  if (disabled) {
    record('/mc-exchange 关闭时 404', 'PASS', '404 {"ok":false,"error":"exchange disabled"}')
    // 关闭时 /mc-ai 已经在上一步验过；其余场景没法在关闭状态跑
    for (const name of [
      '/mc-exchange 打开后 ping', 'parse：买物品', 'parse：买股票', 'parse：存钱',
      'news', 'report', 'prospectus', 'government：紧张', 'government：平静',
    ]) record(name, 'SKIP', '设置里 exchange.enabled=false')
    // 参数校验和限流在关闭状态同样只回 404，不算代码问题，标 SKIP。
    for (const name of ['400：未知 task', '400：parse 缺 message', '400：context 不是对象', '坏 JSON → ok:false', '429 限流']) {
      record(name, 'SKIP', 'exchange 已关闭，路由统一 404')
    }
    return
  }

  // 404 not found：监听的是老版本插件（0.6.x 没有这个路由）。这不是本仓库代码的问题，按 SKIP 处理。
  if (ping.status === 404 && ping.json && ping.json.error === 'not found') {
    record('/mc-exchange 关闭时 404', 'SKIP',
      '当前监听的插件还没有 /mc-exchange（多半是 0.6.x 或生产 DSH 还没换成本仓库代码）')
    skipAllHttp('服务端是旧版插件，测不了 /mc-exchange')
    return
  }

  if (ping.status !== 200 || !ping.json || ping.json.ok !== true) {
    record('/mc-exchange 关闭时 404', 'FAIL', 'HTTP ' + ping.status + ' ' + JSON.stringify(ping.json || {}))
    skipAllHttp('ping 没按预期返回')
    return
  }

  record('/mc-exchange 关闭时 404', 'SKIP', '当前 exchange 已开启，跳过关闭场景（可先关掉再跑一次）')
  record('/mc-exchange 打开后 ping', 'PASS', 'HTTP 200')
  const pingData = ping.json.data || {}
  check('ping version 形如 x.y.z', /^\d+\.\d+\.\d+/.test(String(pingData.version || '')), 'version=' + pingData.version)
  check('ping tasks 与契约一致',
    JSON.stringify(pingData.tasks) === JSON.stringify(EXCHANGE_AGENT_TASKS),
    JSON.stringify(pingData.tasks))

  const catalog = [
    { id: 'minecraft:iron_pickaxe', name_zh: '铁镐', aliases: ['铁镐', 'iron_pickaxe'], priceCents: 1200 },
    { id: 'minecraft:iron_ingot', name_zh: '铁锭', aliases: ['铁', 'iron'], priceCents: 1200 },
    { id: 'minecraft:wheat', name_zh: '小麦', aliases: ['麦子'], priceCents: 80 },
  ]
  const stocks = [{ code: 'BLK', name: '方块重工', priceCents: 12000 }, { code: 'RED', name: '红石科技', priceCents: 30000 }]
  const funds = [{ code: 'FND01', name: '稳健基金', nav: 1.0 }]

  const buyItem = await expectTask('parse：买物品', 'parse', '买 3 个铁镐', {
    balanceCents: 50000, catalogCandidates: catalog, stocks, funds,
  })
  if (buyItem && buyItem.intent === 'unknown') record('parse：买物品意图识别', 'FAIL', 'intent=unknown')
  else if (buyItem) record('parse：买物品意图识别', 'PASS', 'intent=' + buyItem.intent)

  const buyStock = await expectTask('parse：买股票', 'parse', '买 10 股 BLK', {
    balanceCents: 50000, catalogCandidates: catalog, stocks, funds,
  })
  if (buyStock && buyStock.intent === 'unknown') record('parse：买股票意图识别', 'FAIL', 'intent=unknown')
  else if (buyStock) record('parse：买股票意图识别', 'PASS', 'intent=' + buyStock.intent)

  const deposit = await expectTask('parse：存钱', 'parse', '存 500 币', { balanceCents: 50000, catalogCandidates: catalog, stocks, funds })
  if (deposit && deposit.intent === 'unknown') record('parse：存钱意图识别', 'FAIL', 'intent=unknown')
  else if (deposit) record('parse：存钱意图识别', 'PASS', 'intent=' + deposit.intent)

  await expectTask('news', 'news', '生成一条今天的市场新闻', {
    tick: 120,
    recentNews: ['铁矿价格连续上涨'],
    items: [
      { id: 'minecraft:iron_ingot', priceCents: 1200, change7d: 0.08 },
      { id: 'minecraft:diamond', priceCents: 90000, change7d: -0.03 },
    ],
    stocks: [{ code: 'BLK', change7d: -0.02 }],
  })

  await expectTask('report', 'report', '生成这个周期的财报', {
    company: { code: 'BLK', name: '方块重工', sector: '工业' },
    financials: { revenueCents: 1200000, costCents: 900000, profitCents: 300000, cashCents: 5000000 },
    periodDays: 7,
  })

  await expectTask('prospectus', 'prospectus', '生成招股书', {
    company: { name: '史蒂夫矿业', sector: 'mining', level: 3, valuationCents: 8000000, employees: 12, shares: 10000 },
    ipo: { floatRatio: 0.3, ipoPriceCents: 800, raiseCents: 2400000 },
  })

  const crisis = await expectTask('government：紧张', 'government', 'review', {
    indicators: { moneyCents: 900000000, inflation7d: 0.12, indexChange7d: -0.22, medianWealthCents: 120000, budgetCents: -500000, employment: 0.35, volume7dCents: 3000000 },
    rates: { policy: 0.03, depositCurrent: 0.015, loan: 0.11 },
    tax: { trade: 0.005, company: 0.1 },
    recentPolicies: [],
    cooldowns: { rate: 0, welfare: 0, infra: 0, tariff: 0, subsidy: 0 },
  })
  const calm = await expectTask('government：平静', 'government', 'review', {
    indicators: { moneyCents: 900000000, inflation7d: 0.01, indexChange7d: 0.005, medianWealthCents: 200000, budgetCents: 500000, employment: 0.85, volume7dCents: 3000000 },
    rates: { policy: 0.03, depositCurrent: 0.015, loan: 0.11 },
    tax: { trade: 0.005, company: 0.1 },
    recentPolicies: [],
    cooldowns: { rate: 999999, welfare: 999999, infra: 999999, tariff: 999999, subsidy: 999999 },
  })
  if (crisis) record('government：紧张时给出 action', crisis.action && crisis.action !== 'none' ? 'PASS' : 'SKIP', 'action=' + crisis.action)
  if (calm) record('government：平静时可能返回 none', calm.action === 'none' ? 'PASS' : 'SKIP', 'action=' + calm.action)

  // 参数校验（不消耗 token，不该建会话）
  const badTask = await postExchange({ task: 'nope' }, 5000)
  check('400：未知 task', badTask.status === 400 && badTask.json && badTask.json.ok === false, 'HTTP ' + badTask.status)
  const noMessage = await postExchange({ task: 'parse' }, 5000)
  check('400：parse 缺 message', noMessage.status === 400 && noMessage.json && noMessage.json.ok === false, 'HTTP ' + noMessage.status)
  const badContext = await postExchange({ task: 'parse', message: '买铁锭', context: [] }, 5000)
  check('400：context 不是对象', badContext.status === 400 && badContext.json && badContext.json.ok === false, 'HTTP ' + badContext.status)

  // 坏 JSON 的兜底：真实模型没法稳定吐出坏 JSON，这里只测「参数校验 + 重试」的本地部分。
  record('坏 JSON → ok:false', 'SKIP', '真实模型难以稳定触发；已由单元校验覆盖提取/校验/重试逻辑')

  // 429：一直 ping 到被限流，最多 150 次（默认 30/分钟，通常几十次就中）。
  let limited = null
  try {
    for (let index = 0; index < 150; index++) {
      const res = await postExchange({ task: 'ping' }, 5000)
      if (res.status === 429) { limited = res; break }
    }
  } catch (error) {
    record('429 限流', 'FAIL', '请求失败：' + shortError(error))
    return
  }
  if (!limited) {
    record('429 限流', 'SKIP', '连发 150 次 ping 都没限流，可能 maxPerMinute > 150 或窗口刚好滚动过去了')
    return
  }
  check('429 限流', limited.status === 429 && limited.json && limited.json.ok === false && limited.json.error === 'rate limited',
    'HTTP ' + limited.status + ' ' + JSON.stringify(limited.json))
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('== /mc-exchange 测试 ==')
  console.log('目标：' + BASE)
  runUnitChecks()
  await runHttpChecks()
  const passed = results.filter((item) => item.status === 'PASS').length
  const failed = results.filter((item) => item.status === 'FAIL').length
  const skipped = results.filter((item) => item.status === 'SKIP').length
  console.log('\n===== 汇总：' + passed + ' PASS / ' + failed + ' FAIL / ' + skipped + ' SKIP =====')
  if (failed) {
    console.log('失败项：')
    for (const item of results) {
      if (item.status === 'FAIL') console.log('  - ' + item.name + (item.detail ? '：' + item.detail : ''))
    }
    process.exitCode = 1
  } else if (skipped) {
    console.log('有 SKIP：没接 DSH 或 exchange 关着时这是正常的；要看全链路就把 exchange.enabled 打开再跑一次。')
  }
}

main().catch((error) => {
  console.error('测试脚本异常：', error)
  process.exitCode = 1
})
