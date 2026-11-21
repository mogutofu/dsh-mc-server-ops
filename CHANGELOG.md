# Changelog

版本号对应 git tag `vX.Y.Z`。

## 0.7.0 — 2026-11-21

- feat: 新增 `POST /mc-exchange` 严格 JSON 接口（默认关闭），给配套 AIMCmarket 模组用。和 `/mc-ai` 共用同一个本地 HTTP 服务（`ai.port`，默认 8765），6 个 task：`ping` / `parse` / `news` / `report` / `prospectus` / `government`；成功 `200 {"ok":true,"data":{…},"elapsedMs":…}`，参数不合法 400，限流 429，模型或 JSON 修复失败 `200 {"ok":false,…}`
- feat: 新增配置 `exchange.enabled`（默认 `false`）/ `exchange.timeoutSeconds`（20）/ `exchange.maxPerMinute`（30）/ `exchange.maxContextChars`（20000），加进 Config schema 和手写设置页，保存后热生效
- feat: exchange 用独立会话 `mc-exchange:<task>` 和独立 system prompt（只输出 JSON + 该 task 的 schema），不污染小铜的玩家会话，也不把市场上下文带进 `/mc-ai`；这些会话屏蔽工具，模型只能回 JSON
- feat: 服务端 JSON 兜底——剥离 ```json 包裹、取第一个括号配平对象、`JSON.parse` 后按 task 做 schema 校验；失败把错误摘要发回模型重试一次。`message` 截断 200 字，`context` 按 `maxContextChars` 截断；task/intent/action 枚举、物品 id 形如 `minecraft:xxx`、数量 1–576、金额非负整数、政策参数边界（bp / ratio / days / amountCents / sectors / target）全部在服务端校验，不合规直接 `ok:false`
- feat: 全局限流（滑动 60 秒窗口）；日志写 `<服务器目录>\ops\data\mc-exchange.log`，记 task、耗时、是否做过 JSON 提取、成功/失败，不记玩家原话
- test: 新增 `test/mc-exchange.mjs`（纯 Node、无第三方依赖）：纯函数单元校验 + 本机接口矩阵；服务没起或 exchange 关闭时自动 SKIP 并输出 PASS/FAIL/SKIP 汇总；`npm run check` 纳入新文件
- docs: README 新增「AI 市场接口（AIMCmarket，默认关闭）」，配置表、目录结构、安全模型、FAQ 同步
- 兼容性：`/mc-ai` 的请求/响应/会话/限流/日志完全不变；`exchange.enabled=false`（默认值）时 `/mc-exchange` 返回 `404 {"ok":false,"error":"exchange disabled"}`，不建会话、不消耗 token，其余行为与 0.6.7 等价（除版本号）

## 0.6.7 — 2026-11-21

- docs: 同步 mcai 1.4.0——配套 mod / 插件新增 **Bukkit 附件桥接**：只装 Bukkit/Spigot/Paper 插件的服务器，装了 mcai-client 1.4.0 的玩家也能 `/ai screenshot`、`/ai file`（`mcai:bridge` 只传元数据，字节走插件自带 HTTP 上传端口，`plugins/mc-ai/config.yml` 配置）
- docs: 说明 `/mc-ai` 契约在 1.4.0 未变，本插件不需要升级；附件仍是 base64 附件数组，DSH 侧处理逻辑不变

## 0.6.6 — 2026-11-20

- docs: 同步 mcai 1.3.0 多平台发布——配套 mod 现在覆盖 Forge 1.12.2/1.20.1、NeoForge 1.21.1/26.x、Fabric 26.x，以及 Bukkit/Spigot/Paper 通用插件；/mc-ai 契约与 1.2.0 完全一致，插件无需改代码
- docs: 说明 Bukkit 版只有文字 /ai，截图/文件附件仅 Forge/NeoForge/Fabric 的选装客户端模组支持

## 0.6.5 — 2026-11-15

- fix: 小铜在 QQ 群里仍按旧记忆拒绝改天气——给所有 QQ 会话的 system prompt 注入「服务器操作能力」清单，明确**所有玩家都能用 weather 动作、不要回复只有服主能做**
- fix: 模型如果还是用旧习惯发 `cmd weather rain`，插件会把这条参数直接转成 weather 动作处理（玩家不再被 cmd 的服主限制拦住）
- fix: 工具参数对象是只读的，转天气时不再原地改写 `args.arg`（修掉 `Cannot assign to read only property 'arg'` 崩溃）
- docs: 旧会话历史里全是「只有服主能做」，如仍不生效可在群里发 `/new` 开新会话再试

## 0.6.4 — 2026-11-15

- feat: `mc_server` 新增 `weather` 动作——QQ 群里玩家也能让小铜改天气（用自己**绑定且在线**的游戏名执行 `execute as <游戏名> run weather <类型>`，走 mod 的在线人数/投票规则）；服主直接执行
- fix: 玩家在 QQ 群请求改天气不再被「只有服主能做」拒绝（之前只能走服主专属的 `cmd`；模型也拿到了明确的 weather 动作说明）
- docs: README 补充 QQ 侧天气用法（先 bind-player 绑定游戏名并在线）

## 0.6.3 — 2026-11-15

- feat: 游戏内天气投票——配套 mcai mod 1.2.0：玩家用 `/weather clear|rain|thunder [秒]` 改天气；在线 ≤ `directThreshold`（默认 2）直接生效，3 人及以上发起投票（`/vote yes|no|status`），默认 2 票同意通过、1 票反对作废、60 秒超时、60 秒发起冷却
- feat: 设置面板新增「游戏内天气投票」配置（开关 / 免投票人数 / 同意票 / 反对票 / 超时 / 冷却），保存后写到服务器 `config/mcai-weather.json`，mod 每次 `/weather` 都读这个文件，改完即时生效、不用重启
- docs: README 补充天气投票说明与配置项

## 0.6.2 — 2026-11-08

- feat: 群 openid 自动发现——插件加载时给 qqbot 的 `inbound.js` 打一个幂等抓取钩子（写 `ops/data/qq-keys.txt`），群友在群里 @ 一次机器人即可自动填好目标群，新装用户不用再手填 openid；qqbot 升级把钩子冲掉后，插件下次加载会自动重打（失败安全，不写坏 qqbot）
- feat: 没有目标群时，`bridge.log` / `bridge-state.lastError` / 设置面板都会提示「在群里 @ 一次机器人即可自动发现」

## 0.6.1 — 2026-11-08

- fix: 重装/升级插件后 `bridge.groups` 丢失导致群服互通沉默——群 openid 现在会持久化到 `ops/data/bridge-groups.json`；配置里 groups 为空时自动用「上次记住的群」，再退到「最近捕获的群」（`ops/data/qq-keys.txt`）
- fix: 群目标为空/自动恢复时写 `bridge.log`（`群目标：…（来源：config / remembered / captured）`），`bridge-state.json` 增加 `groups` 与 `groupsSource`，排查不再靠猜
- fix: `mc_server bridge-groups` 在 QQ 接口 404（不支持列群）时回退到本地记录/最近捕获的群，而不是直接报错
- docs: README/docs 说明群 openid 的自动记忆与恢复；设置面板「转发到哪些群」留空即自动

## 0.6.0 — 2026-11-08

- feat: 游戏内 `/ai` 支持附件——配套 Forge mod 1.1.0 可在请求里带 1 个图片或文件附件；`POST /mc-ai` 新增可选 `attachments` 数组，不带时行为和旧版完全一致
- feat: 图片附件解码校验后交给 DSH 的 `attachments.saveImages()` 归一化存储，消息里放 `{type:"image", attachment}` 让模型直接看图
- feat: 文件附件交给 `attachments.saveFile()` 落盘，消息里放 `{type:"file", attachment}`，由 DSH 投影成带只读保存路径的文本，agent 用文件工具读
- feat: 文本类小文件（≤100KB、UTF-8 可解码、常见文本扩展名或可打印比例高）直接把内容内联进 user message 文本块，不再依赖 agent 的文件工具；大文件/二进制仍落盘走 file 块路径投影
- feat: 附件校验——只接受规范 base64；图片 mediaType 仅 png/jpeg/webp/gif；图片 ≤ 8MB、文件 ≤ 16MB、总 ≤ 24MB；坏数据/超限返回 `{ok:false,error:"中文原因"}`，不崩、不建回合
- chore: `mc-ai.log` 记录附件概要（如 `[att 1 image/png 230KB]`），请求体加 40MB 硬上限
- docs: README 补充 `/mc-ai` attachments 协议、大小限制和安全说明（只监听 127.0.0.1；附件存进 DSH home 的 attachments 存储、目前不会自动删除；玩家本地上传的文件会发给 AI）

## 0.5.4 — 2026-11-07

- feat: 游戏内 AI 对话——配套 Forge mod 的 `/ai <内容>` 走本地 `127.0.0.1:8765/mc-ai`（只监听回环；按玩家 UUID 复用 `mc-ai:<uuid>` 会话，上下文连续，不占本机界面会话）
- feat: 新增 `ai` 配置（`enabled` / `port` / `timeoutSeconds`），改完立刻生效
- fix: 创建 agent 时带上默认模型路由（`agentDefaultModel.currentSelection()`）；恢复的老会话用 `agent.model.select()` 覆盖已失效的旧路由，重启 DSH 后不再出现「小铜没说话」
- fix: 会话已落盘时 `agents.create` 失败会回退 `agents.resume`
- fix: agent 回合出错时把真实原因写进 `mc-ai.log` 并回给 mod，不再静默吞成空回复

## 0.5.3 — 2026-11-07

- fix: 自更新兼容带空格的安装路径

## 0.5.2 — 2026-11-07

- docs: README 重构——顶部加 badges、一句话定义、版本行、「它解决什么问题」；末尾新增 7 条 FAQ
- chore: `package.json` 补 `author`，keywords 从 9 个补到 15 个
- chore: 新增 `CHANGELOG.md`

## 0.5.1 — 2026-11-07

- feat: 设置面板内置检查更新（npm 优先，失败回退 GitHub Releases）
- chore: 默认配置调整

## 0.5.0 — 2026-11-06

- feat: 群服互通合并窗口自适应（最近发言节奏 + 在线人数）
- chore: 死亡消息默认开、进出服消息默认关

## 0.4.1 — 2026-11-04

- chore: 声明 `engines.dsh`（宿主版本要求）

## 0.4.0 — 2026-11-04

- feat: 群服互通——游戏聊天直通 QQ 群（不经过 AI、不耗 token）

## 0.3.0 — 2026-11-02

- feat: 首个公开版本——`mc_server` 工具、权限守卫、人设注入
