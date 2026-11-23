# dsh-mc-server-ops

[![npm version](https://img.shields.io/npm/v/dsh-mc-server-ops.svg)](https://www.npmjs.com/package/dsh-mc-server-ops)
[![npm downloads](https://img.shields.io/npm/dm/dsh-mc-server-ops.svg)](https://www.npmjs.com/package/dsh-mc-server-ops)
[![license](https://img.shields.io/npm/l/dsh-mc-server-ops.svg)](https://github.com/mogutofu/dsh-mc-server-ops/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.0-blue)](https://github.com/deepseek-ai)

**在 QQ 群里管理 Minecraft 服务器。** 服主不用开电脑、不用记命令——群里发一句话，就能查状态、启停服务器、绑白名单、投票授权；游戏聊天还能直通 QQ 群，不经过 AI、不耗 token。

> 当前版本 **0.7.0** · 更新于 **2026-11-21** · 以本页和 [npm](https://www.npmjs.com/package/dsh-mc-server-ops) 为准

## 它解决什么问题

- **服主不在电脑前**：群里问一句「服务器卡吗」，直接回 TPS、在线玩家、CPU、内存、磁盘
- **朋友想自己开服**：服务器确认关闭或假死时，群友也能重启，不用等服主
- **改东西怕手滑**：动 world / ops\data / 白名单要 2 位群友投票，凑不满就作废
- **群里看不到游戏里聊啥**：游戏聊天直通 QQ 群，不经过 AI、不耗 token
- **一条命令搞崩服**：`kill @a`、`whitelist off` 这类静态拦截，服主也发不出去

## 前置插件（必须）

插件本身只是「服务器操作 + 人设」这一层，**聊天通道由 QQ 机器人插件提供**。安装前请先装好并配置 `@tencent-connect/dsh-qqbot`（见下方表格），否则装上了也没有入口。

| 插件 | 作用 | 获取 |
| --- | --- | --- |
| `@tencent-connect/dsh-qqbot` | QQ 群/私聊通道：把群消息送进 Harness，把回复发回群里 | npm / DSH 插件市场 |

没有它，本插件仍然会加载 `mc_server` 工具（本地 GUI 会话里可以用），但群里没人能触发它。

## 它做什么

- **状态**：进程、在线玩家、CPU、内存、TPS、磁盘、运行时长，并给出「正常 / 卡顿 / 无响应假死 / 启动中」判定
- **启停**：start / stop / restart；假死自动强杀重启；确认关闭或假死时玩家也能重启
- **日志**：最近日志（过滤 RCON 噪音）、最近一次崩溃的上下文
- **白名单**：QQ ↔ 游戏名绑定，自动写入 `whitelist.json`（保留大小写，避免离线 UUID 不匹配）
- **配方**：`kubejs` 脚本备份 / 重载
- **授权**：动受保护区域（world、ops\data、白名单）要 2 位群友投票；**凑满 2 票之前任何人反对就作废**
- **人设**：默认「小铜」，名字和语气都能在设置里改
- **游戏内 AI**：装上配套 mc-ai mod 后（1.3.0 起支持 Forge / NeoForge / Fabric / Bukkit），玩家在游戏里 `/ai <内容>` 就能和「小铜」对话（只监听 `127.0.0.1`，按玩家 UUID 复用独立会话）；mod 1.1.0 起还能带截图/文件附件；1.4.0 起 **Bukkit 插件也有附件桥接**——只装插件的服务器上，装了 mcai-client 1.4.0 的玩家同样能用 `/ai screenshot`、`/ai file`（字节走插件自带 HTTP 上传端口，`plugins/mc-ai/config.yml` 配置）
- **AI 市场接口**：配套 AIMCmarket 模组（Forge 1.20.1 服务端-only）可用 `POST /mc-exchange` 让 AI 做结构化解析、市场新闻、财报、招股书和政府政策建议；默认关闭、独立会话、严格 JSON、带限流，关掉时不影响任何现有功能
- **天气投票**：配套 mc-ai mod 1.2.0 起（1.3.0 起所有平台一致），游戏内玩家可用 `/weather` 改天气；在线 ≤2 人直接生效，3 人及以上要 `/vote yes` 投票（2 票同意通过），门槛都能在设置面板改

## 安装

```bash
# 1) 先装 QQ 机器人插件并配好 AppID / AppSecret
dsh plugin add @tencent-connect/dsh-qqbot

# 2) 再装本插件
dsh plugin add dsh-mc-server-ops
```

本地开发可以直接指向目录：

```bash
dsh plugin add /path/to/dsh-mc-server-ops
```

安装后重启 DSH，在「设置 → 插件 → mc-server-ops」里填服务器目录。

## 检查更新

设置面板最上面有一条更新栏，**强制开启、没有开关**：

```
当前版本号为 0.6.0                        [检查更新]
[新版本 v0.7.0]                           [检查更新]
```

- 面板一打开就自动查一次，**npm 优先**（`registry.npmjs.org/<包名>/latest`），npm 不通才问 GitHub 的 `releases/latest`。
- 有新版本时按钮变成可点的「新版本 vX」。点一下自动更新：先走 npm，失败再走 GitHub 的 tag tarball，都失败才提示「下载失败，请手动更新」。
- 没有新版本时显示纯文本「当前版本号为 X」，不可点击。
- 右边的「检查更新」是手动重查，结果会以文字提示（「已经是最新版本」/「发现新版本」）。

两个前提：更新用的是 DSH 自带的 pnpm，所以要有写 profile 目录的权限；如果是 `link:` 本地安装（开发模式），自动更新会断开链接，插件会直接提示手动更新。

## 配置（设置界面可改）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `server.dir` | 空 | 服务器目录（含 `server.properties`、`mods`、`java`）。留空则读环境变量 `MC_SERVER_DIR`，再不行用 `D:\server` |
| `server.rconPort` | `25575` | RCON 端口，需在 `server.properties` 里 `enable-rcon=true` |
| `server.rconPassword` | 空 | 留空则从 `server.properties` 读取 |
| `persona.enabled` | `true` | 是否注入人设 |
| `persona.name` | `小铜` | 助手在群里的名字 |
| `persona.text` | 空 | 人设正文；留空用内置默认（小铜）。**改人设就改这里，不用动代码** |
| `persona.scope` | `qq` | `qq` 只注入 QQ 群/私聊；`all` 所有会话；`none` 关闭 |
| `ops.allowPlayerWrite` | `true` | 允许玩家改服务器目录下非敏感文件 |
| `ops.grantHours` | `12` | 服主确认后可编辑文件/执行命令的有效时长 |
| `adapter` | `local` | 写操作走哪条路：`local` 本机脚本；`panel` Pterodactyl 面板 HTTP API |
| `panel.url` | 空 | 面板地址，`adapter=panel` 时必填 |
| `panel.serverId` | 空 | 面板里该服务器 URL 最后一段（8 位短 ID） |
| `panel.clientApiKey` | 空 | 客户端 API Key（`ptlc_` 开头） |
| `vote.approveNeed` | `2` | 通过需要几位群友同意 |
| `vote.rejectNeed` | `1` | 几位反对就作废（1 = 一票否决） |
| `vote.timeoutMinutes` | `15` | 多久没凑够门槛自动作废 |
| `vote.vetoEnabled` | `true` | 是否允许一票否决；关掉后反对票只记录、不作废 |
| `vote.protectedPaths` | `world, ops/data, whitelist` | 改动这些位置需要群友投票放行 |
| `bridge.enabled` | `true` | 是否启用群服互通（游戏聊天 → QQ 群） |
| `bridge.mode` | `auto` | `auto` 有玩家在线才转发 / `on` 常开 / `off` 常关 |
| `bridge.groups` | `[]` | 转发到哪些群（群 openid）；留空 = 自动用上次记住/最近捕获的群，重装插件不会哑 |
| `bridge.events` | 三项都关 | 除聊天外还转发哪些事件（进出服和死亡默认不转，防刷屏） |
| `bridge.coalesceMs` | `3000` | 固定合并窗口（`coalesce.mode=fixed` 时用） |
| `bridge.coalesce.mode` | `auto` | 合并窗口：`auto` 按最近发言节奏 + 在线人数自动调整 / `fixed` 固定 |
| `bridge.coalesce.minMs` / `maxMs` | `1000` / `60000` | 自动模式的最短 / 最长等待 |
| `bridge.coalesce.sampleSize` | `3` | 用最近几条发言算节奏（2–6） |
| `bridge.coalesce.quietMs` | `60000` | 超过这么久没说话算冷场，直接按最短等待 |
| `bridge.coalesce.fullPlayers` | `2` | 在线人数达到这个值算「人多」 |
| `bridge.coalesce.fastMs` | `50000` | 相邻两条发言间隔小于这个值算「话密」 |
| `bridge.maxPerDay` | `900` | 每群每天发送上限（官方上限 1000） |
| `bridge.appId` / `appSecret` | 空 | 留空自动从本机 qqbot 插件配置读取 |
| `ai.enabled` | `true` | 是否开游戏内 `/ai` 对话（需要配套 mc-ai mod，支持 Forge / NeoForge / Fabric / Bukkit；只监听 `127.0.0.1`） |
| `ai.port` | `8765` | mod 连接的本地端口 |
| `ai.timeoutSeconds` | `60` | 等 AI 回复的超时秒数 |
| `exchange.enabled` | `false` | AI 市场接口（AIMCmarket）总开关；默认关闭，关着时 `/mc-exchange` 返回 404，不建会话、不花 token |
| `exchange.timeoutSeconds` | `20` | `/mc-exchange` 单次等模型的超时（秒） |
| `exchange.maxPerMinute` | `30` | `/mc-exchange` 全局限流（次/分钟），超了 429 |
| `exchange.maxContextChars` | `20000` | 请求 `context` 序列化后的最大字符数，超了服务端截断 |
| `weather.enabled` | `true` | 允许游戏内玩家用 `/weather` 改天气（需要 mc-ai mod 1.2.0+；1.3.0 起支持全部平台） |
| `weather.directThreshold` | `2` | 在线 ≤ 这个数时直接改天气；更多人才发起投票 |
| `weather.approveNeed` / `weather.rejectNeed` | `2` / `1` | 通过需要几票同意 / 几票反对作废（发起人自动算 1 票同意） |
| `weather.timeoutSeconds` | `60` | 投票有效期（秒） |
| `weather.cooldownSeconds` | `60` | 同一玩家两次发起的最小间隔（秒） |
| `time.enabled` | `false` | 允许玩家投票改游戏时间（插件自己实现，**不需要 mod**；默认关闭） |
| `time.directThreshold` | `2` | 在线 ≤ 这个数直接改时间，更多人才发起游戏内投票 |
| `time.approveNeed` / `time.rejectNeed` | `2` / `1` | 通过需要几票同意 / 几票反对作废（发起人自动算 1 票同意） |
| `time.timeoutSeconds` / `time.cooldownSeconds` | `60` / `60` | 投票有效期 / 同一玩家两次发起的最小间隔（秒） |
| `ai.playtimeGate` | `true` | 白名单开启时，绑定玩家游戏时长不足门槛前禁止让小铜操作服务器（聊天和查询不受影响；**服主豁免**） |
| `ai.minPlaytimeMinutes` | `60` | 游戏时长门槛（分钟），按玩家绑定账号里时长最长的一个算 |

## 目录结构

```
dsh-mc-server-ops/
├── index.js            # 插件宿主代码：mc_server 工具、权限守卫、人设注入、/mc-ai 与 /mc-exchange
├── cordis.patch.yml    # 安装时自动插入的加载行
├── test/
│   └── mc-exchange.mjs # /mc-exchange 测试：纯函数单元校验 + 本机接口矩阵（无第三方依赖）
└── ops/
    ├── command-guard.mjs   # 静态命令拦截：出网前掐掉“一条命令搞崩整个服”的类型
    ├── qq-bridge.mjs       # 群服互通：读日志 → 直连 QQ 开放平台（不经过 AI）
    ├── coalesce.mjs        # 合并窗口计算：最近发言节奏 + 在线人数 → 等多久再发（纯函数）
    ├── mc-exchange.mjs     # /mc-exchange：请求校验、输入裁剪、JSON 兜底、data schema 校验（纯函数）
    ├── rcon.mjs            # 跨平台核心：RCON、进程探测、日志、状态汇总
    ├── rcon-probe.mjs      # 极简 RCON 探测（查在线玩家）
    ├── adapters/           # 写操作适配器：local（本机脚本）/ panel（Pterodactyl）
    ├── mcadmin.ps1         # 运维入口（status/start/stop/投票/白名单…）
    ├── watchdog.ps1        # 看门狗：崩溃自动拉起
    └── server-console.ps1  # 带日志着色的服务器控制台
```

首次运行时插件会把 `ops/*.ps1` 复制到 `<服务器目录>\ops\`（`rcon.mjs` 留在包里直接调用，不复制），运行期数据（`bindings.json`、`votes.json`、`state.json`、`owners.json`）也生成在那里，**不会**写进本仓库。

## 服主和群友：怎么区分、怎么绑定

默认**所有人都是群友**：只能查状态、看日志、问问题。
服主名单存在 `<服务器目录>\ops\data\owners.json`，只有名单里的 QQ 能执行高危动作（stop / restart / cmd / 白名单 / 导出等）。

### 绑定服主（只在设置面板里做）

1. 打开「设置 → MC 服务器 → 服主绑定」
2. 在输入框里填对方的 QQ openid，点「添加为服主」
3. 名单会立刻刷新，每行右边有「移除」

**QQ openid 怎么拿：** 群消息开头都是 `[昵称 (ID)]`，括号里那串就是（例如 `[蘑菇来吃鱼 (34EB...CB)]`）。群友自己不知道的话，在群里 @ 机器人 问一句「我的 ID 是多少」，它会原样念出来——这串 ID 本来在群里就可见，不算秘密。

服务器本机的等价命令：

```
powershell -File <服务器目录>\ops\mcadmin.ps1 -Action owner-add -Arg <openid> -Actor LOCAL-CONSOLE
```

名单为空时这条命令不需要权限（引导用），一旦有了服主就只有服主能加人；群聊、私聊里都不能自行提权。

### 其他

- `owner-list` 查看名单、`owner-del` 移除（后两个仅服主）
- 群友无法通过任何方式给自己提权；改 world / ops\data / 白名单这种受保护区域必须走投票

## 功能开关（设置界面里逐项开关）

权限分成两层：**基础权限**（授权窗口、玩家能不能改文件）和**功能开关**（下面这 9 项）。关掉的那一项，玩家调用时插件会直接拒绝并说明原因，不会走到脚本；服主不受影响。

| 开关 | 默认 | 关掉之后 |
| --- | --- | --- |
| `voteEscalation` 投票放权 | 开 | 只有服主能改 world / ops\data / 白名单 |
| `kubejsEdit` 改 KubeJS 配方 | 开 | 玩家改 `kubejs/` 被拒 |
| `configEdit` 改配置 | 开 | 玩家改 `config` / `defaultconfigs` / `server.properties` 被拒 |
| `playerStart` 玩家开服 | 开 | 服务器关着也只有服主能开 |
| `playerRestart` 玩家重启 | 开 | 崩溃/假死时也只有服主能重启 |
| `playerStop` 玩家停服 | **关** | 玩家永远不能停服 |
| `gamemodeSwitch` 切模式 | 开 | 玩家不能把自己切生存/旁观 |
| `say` 游戏内广播 | 开 | 玩家不能 `say` |
| `fileSend` 发文件到群 | 开 | 玩家不能把文件发到群里 |

投票门槛也能改：`vote.approveNeed`（默认 2 位同意）、`vote.rejectNeed`（默认 1 位反对即作废）、`vote.timeoutMinutes`（默认 15 分钟）、`vote.vetoEnabled`（关掉后反对票只记录、不作废）、`vote.protectedPaths`（哪些位置算受保护区域，默认 world / ops/data / whitelist）。保存后会写进 `ops\data\vote-config.json`，脚本每次调用时读它。

## 命令拦截（静态，绕不过去）

`ops/command-guard.mjs` 是 RCON 出网前的最后一道闸，只拦“一条命令就能把服搞崩”的类型：

| 拦截项 | 谁能发 |
| --- | --- |
| `kill @a` / `kill @e` / `kill @r` / `kill *` | 谁都发不了 |
| `kick @a` / `kick @e` | 谁都发不了 |
| `whitelist off` / `whitelist clear` | 谁都发不了 |
| `execute ... run kill @a` | 谁都发不了（换个写法也绕不过） |
| `stop` | 只有服主 |

`op` / `deop` / `execute` / `ban` 这类**正常管理指令不拦**——它们本来就是 `cmd` 的用途，只在插件层限制“只有服主能发”。`say` / `tell` / `msg` / `title` 等聊天类前缀直接放行，避免把聊天内容误判成指令。

同一套规则在两处生效：插件层（`index.js`）判身份，PowerShell 层（`mcadmin.ps1` 的 `Assert-CommandSafe`）兜底——直接调脚本也拦得住。

## 连接方式：本机 / Pterodactyl 面板

`adapter` 决定 `start` / `stop` / `restart` / `cmd` 这四个写操作走哪里：

- **`local`（默认）** — 本机直接跑 `ops/mcadmin.ps1`（Windows）或 `ops/rcon.mjs`（其它平台），行为和以前完全一致。
- **`panel`** — 走 Pterodactyl 客户端 API：`POST /api/client/servers/{id}/power`（`signal` = `start` / `stop` / `restart` / `kill`）、`POST /api/client/servers/{id}/command`，鉴权头 `Authorization: Bearer <clientApiKey>`。

只读操作（`status` / `players` / `logs` / `crashinfo`）不经过适配器。要接别的面板（Pelican、AMP、PufferPanel）只需再写一个适配器文件，接口就五个方法：`start` / `stop` / `restart` / `sendCommand` / `getStatus`。

## 群服互通（游戏聊天 → QQ 群）

**不经过 AI，不消耗 token。** 桥直接读服务器日志、直接调 QQ 开放平台接口：群里的人能看到游戏里说了什么，全程不创建 agent 会话、不调模型。

| 模式 | 行为 |
| --- | --- |
| `auto`（默认） | 有玩家在线才转发；服务器空转时自动静默，不占配额 |
| `on` | 常开 |
| `off` | 常关 |

转发内容：玩家聊天（始终）、加入 / 离开（默认关，会刷屏）、死亡消息（默认开）。

### 合并窗口怎么自动调

默认 `auto`：每来一条新消息都重算一次等待时长，两个因子加权——

- **最近的发言节奏**（权重 0.6）：只用 `quietMs` 内最近 2–3 条发言的相邻间隔。间隔 ≤ `fastMs` 算满活跃，≥ `quietMs` 算冷场，中间线性。
- **在线人数**（权重 0.4）：`在线人数 / fullPlayers`，到满档算 1。

结果夹在 `[minMs, maxMs]`：人少话稀（冷场、单人）基本是 1 秒内就发；人多话密最多攒 6 秒，攒成一条再发。

两个刻意的设计：

- **长时间没人说话不会把间隔拖长**：只用「安静窗口内」的相邻间隔算节奏，几小时前的那条发言根本不参与；窗口也没有「距上次发言多久」这类项。
- **持续刷屏不会无限延后**：等待上限锁在「这一批开始攒」之后的 `maxMs`，到点必发。

状态行会显示当前判定（例如 `合并窗口：2.4s · 活跃度 42% · 最近间隔 3.1s · 在线 2 人`），方便对着调参。

实现要点：

- **收** — 增量 tail `logs/latest.log`，**按字节切行**（中文是多字节，先转字符串再切会在块边界切坏字），再识别 `<玩家> 内容`、`joined the game`、`left the game`。
- **编码** — 服务器的日志是**系统编码**（中文 Windows 上是 GBK），不是 UTF-8。解码器先按 UTF-8 试，出现替换字符 `U+FFFD` 就自动退回 GBK。这一步不做的话，中文在 QQ 里会变成 `��ôţ��`。
- **发** — 直接 `POST https://api.bot.qq.com/v2/groups/{openid}/messages`，头是 `Authorization: QQBot <access_token>`；token 用 AppID/AppSecret 换，缓存到过期前 1 分钟。
- **聚合** — 多条游戏消息合成一条。默认按「最近发言节奏 + 在线人数」自动定窗口（见上一节），也可以切成固定 `coalesceMs`。官方对群主动消息的限制是 **20 条/分钟、每群 1000 条/天**，一条游戏聊天发一条 QQ 会很快撞墙。
- **限流** — `maxPerDay`（默认 900）本地兜底，超了停发，面板状态行会显示原因。
- **清洗** — URL 换成 `[链接]`（QQ 会拒收含 URL 的主动消息）、剥掉颜色码 `§x` 和控制字符、单条截断到 900 字。
- **防环** — 带 `[群]` / `[QQ]` 前缀的消息不再转发，避免 QQ → 游戏 → QQ 打转。

配置在设置面板的「群服互通」里，**改完立刻生效**（不用重启），状态行会显示「运行中 / 在线几人 / 今日已发几条 / 错误原因」。

群 openid 不知道怎么办：**第一次不用填**。插件加载时会自动给本机 qqbot 的 `inbound.js` 打一个幂等抓取钩子（带标记、先备份、失败不影响 qqbot），机器人收到群消息时会把群 openid 写进 `ops/data/qq-keys.txt`；群友在群里 **@ 一次机器人**，群服互通就会自动用上这个群，不需要手填。详细说明见 [docs/qq-bridge.md](https://github.com/mogutofu/dsh-mc-server-ops/blob/main/docs/qq-bridge.md)。

如果 qqbot 升级把钩子冲掉了：插件下次加载会自动重打；实在不行也可以手动填 `bridge.groups`（`mc_server bridge-groups` 会给出本地记录过的群 openid）。

插件会自动记住用过的群：正常转发过一次后，群 openid 会存到 `ops/data/bridge-groups.json`；`bridge.groups` 留空或因为重装插件被重置时，自动用上次记住的群，再退回最近捕获的群（`ops/data/qq-keys.txt`），所以**重装/升级插件不会再让群服互通断掉**。状态和日志里会标出来源（`config` / `remembered` / `captured`）。

## 游戏内 AI 对话（/ai）

配套 mc-ai mod：[mogutofu/dsh-mc-ai-chat](https://github.com/mogutofu/dsh-mc-ai-chat)（1.3.0 起支持 Forge 1.12.2/1.20.1、NeoForge 1.21.1/26.x、Fabric 26.x，以及 Bukkit/Spigot/Paper 通用插件；**1.4.0 起 Bukkit 插件也有附件桥接**，只装插件的服务器上装了 mcai-client 1.4.0 的玩家也能用 `/ai screenshot`、`/ai file`）。玩家在游戏里输入 `/ai 你好`，mod 会把请求 POST 到本机 `127.0.0.1:8765/mc-ai`，插件开一个 agent 回合，再把回复贴回玩家聊天栏。mod **1.1.0** 起还支持附件：`/ai screenshot` 截游戏画面、`/ai file <路径>` 读玩家本机的文件；`/mc-ai` 契约在 1.4.0 未变，本插件无需改代码。

| 项 | 说明 |
| --- | --- |
| 监听 | 只听 `127.0.0.1`，公网进不来；端口默认 8765 |
| 会话 | 每个玩家 UUID 一个会话 `mc-ai:<uuid>`，上下文连续；不是本机界面会话，按「群友」权限管 |
| 协议 | `POST /mc-ai`，请求 JSON `{"player":"名字","uuid":"UUID","text":"内容","attachments":[…]}`（`attachments` 可省略，旧请求完全兼容）→ 回复 `{"ok":true,"reply":"…"}`；HTTP 200 也可能是 `ok:false`，以 `ok` 字段为准 |
| 附件 | 一次最多 1 个；元素 `{kind:"image"\|"file", name, mediaType, data}`，`data` 必须是**规范 base64**（不能带空白/换行）。图片 `mediaType` 只接受 `image/png` / `image/jpeg` / `image/webp` / `image/gif`，解码后 ≤ 8MB；文件 ≤ 16MB；单次请求总大小 ≤ 24MB |
| 配置 | `ai.enabled` / `ai.port` / `ai.timeoutSeconds`，改完立刻生效 |
| 排障 | 回复「（小铜没说话）」通常是 agent 没拿到可用的模型路由：检查 DSH 的默认模型（`agentDefaultModel`）是否指向有效 provider；`<服务器目录>\ops\data\mc-ai.log` 会记录每次请求和真实错误（带附件时还会记概要，如 `[att 1 image/png 230KB]`） |

附件怎么走：

- **图片**：mod 把截图/图片读成 base64 发过来 → 插件解码校验后交给 DSH 的 `attachments.saveImages()` 归一化存储 → 消息里放 `{type:"image", attachment:<ref>}`，模型直接看图。所选模型要支持图片输入（默认的 `deepseek-flash` 支持）。
- **文件**：文本类小文件（≤100KB、UTF-8 可解码）直接把内容**内联**进消息文本块，模型当场就能看到，不依赖 agent 的文件工具；大文件或二进制才存进 DSH 的附件存储（`attachments.saveFile()`）→ 消息里放 `{type:"file", attachment:<ref>}` → DSH 发请求前把文件块投影成一段带**只读保存路径**的文本，agent 需要内容时自己用 `read` 等文件工具去读。
- **校验失败不建回合**：坏 base64、不支持的图片类型、超过大小限制都返回 HTTP 200 + `{"ok":false,"error":"中文原因"}`，服务不崩；文本请求的行为和旧版一致。

**附件安全说明：**

- 入口只监听 `127.0.0.1`，外网连不上，能发请求的只有本机的 mod。
- 附件会**真的落进 DSH home 的附件存储**（默认 `C:\Users\<用户>\.dsh\attachments\v1\`，按内容 sha256 去重），目前**不会自动删除**，时间长了要自己清理。
- 玩家在游戏里发的截图、本机文件会经 mod 上传给 AI：模型能看到图片内容，agent 能读文件内容（文本类小文件会直接内联进消息发给模型）——让玩家知道自己发的是什么。大文件只会在附件存储里留一份只读副本，不会写回玩家给的路径。
- 附件请求和文本请求走同一个每玩家串行队列，且 mod 侧默认每玩家 5 秒冷却，不会并发插队刷屏。

游戏内玩家和群友一样受权限守卫限制：只读查询可以，写文件、执行命令需要服主授权；mod 侧默认每玩家 5 秒冷却，避免刷屏。

## AI 市场接口（AIMCmarket，默认关闭）

这是给 [AIMCmarket](https://github.com/mogutofu/dsh-aimcmarket)（Forge 1.20.1 服务端-only 模组）用的结构化接口。模组把「市场先生」和「AI 政府」里需要 AI 的部分（自然语言→订单参数、市场新闻、财报、招股书、政策建议）发过来，DSH 用独立会话和独立 system prompt 只回一个 JSON 对象；扣钱、发货、政策落地这些还是模组自己算。

默认关闭。关着的时候 `/mc-exchange` 直接 404，不建会话、不花 token，`/mc-ai`、群服互通、天气这些都不受影响。

打开方式：设置 → MC 服务器 → 「AI 市场接口（AIMCmarket）」，勾上「开启 /mc-exchange」；或者把配置里的 `exchange.enabled` 改成 `true`。保存后立刻生效，不用重启 DSH。它和小铜的 `/ai` 共用同一个本地 HTTP 服务（`127.0.0.1:<ai.port>`，默认 8765），所以 `ai.enabled=false` 时整个端口都不监听，exchange 也用不了。

### 接口长什么样

`POST /mc-exchange`，`Content-Type: application/json`：

```json
{"task":"parse","player":"AIMCmarket","uuid":"00000000-0000-0000-0000-00000000a1c0","message":"买 3 个铁镐","context":{"balanceCents":50000}}
```

六个 task：`ping`、`parse`、`news`、`report`、`prospectus`、`government`。`ping` 是静态的，用来确认版本和任务列表：

```bash
curl -s http://127.0.0.1:8765/mc-exchange -H 'content-type: application/json' -d '{"task":"ping"}'
# {"ok":true,"data":{"version":"0.7.0","tasks":["parse","news","report","prospectus","government"]},"elapsedMs":1}
```

其余五个会走 agent，data 形状如下（字段细节和枚举见模组仓库的 `docs/AI-PROTOCOL.md`，服务端也按同一份 schema 校验）：

| task | 请求里带什么 | data |
| --- | --- | --- |
| `parse` | `message`=玩家原话，`context` 带余额/物品候选/股票/基金 | `{"intent":"buy","items":[{"id":"minecraft:iron_pickaxe","count":3}],"symbol":"","shares":0,"amountCents":0,"reply":"…"}` |
| `news` | `context` 带最近行情和新闻 | `{"headline":"…","body":"…","effects":[{"target":"minecraft:iron_ingot","multiplier":1.08,"ticks":6}]}` |
| `report` | `context` 带公司财务状况 | `{"revenueCents":1200000,"profitCents":300000,"outlook":"up","headline":"…"}` |
| `prospectus` | `context` 带公司/IPO 数据 | `{"title":"…","summary":"…","risk":"…","useOfFunds":"…"}` |
| `government` | `context` 带宏观指标、利率、税、冷却 | `{"action":"none\|rate_cut\|rate_hike\|welfare\|stimulus\|austerity\|subsidy\|tariff\|liquidity\|min_wage","params":{…},"reason":"…","announcement":"…"}` |

成功回 `200 {"ok":true,"data":{…},"elapsedMs":123}`。模型输出不一定是干净 JSON，所以服务端会先剥离 ```json 包裹、取第一个括号配平的对象、`JSON.parse`、再按 task 做 schema 校验；校验不过就把错误摘要发回模型重试一次（要求只输出 JSON），还不行就回 `200 {"ok":false,"error":"…","raw":"…"}`，由模组自己降级到 `/mc-ai` 或本地规则。

状态码：功能关闭 `404 {"ok":false,"error":"exchange disabled"}`；参数不合法 `400 {"ok":false,"error":"…"}`；限流 `429 {"ok":false,"error":"rate limited"}`；模型报错/超时/JSON 修复失败都是 `200` + `ok:false`（HTTP 层不炸）。

### 服务端做了什么

- **独立会话**：每个 task 一个 `mc-exchange:<task>` 会话，system prompt 里只有「只输出 JSON + 这个 task 的 schema」，不会混进小铜的玩家会话，市场上下文也不会带进 `/mc-ai`。这些会话不给工具权限，模型只能回 JSON。
- **裁剪输入**：`message` 超过 200 字截断；`context` 序列化后超过 `exchange.maxContextChars`（默认 20000）会先收缩数组/截断字符串，再不行换成带 preview 的截断 JSON，不会因为 context 太大把请求搞崩。
- **校验独立于模型**：task / intent / action 枚举、物品 id 形如 `minecraft:xxx`、数量 1–576、金额非负整数、政策参数边界（`bp` 25/50/75/100、`ratio` 范围、`days` 1–30、`amountCents`、`sectors` 数组、`target` 字符串）都在服务端重算一遍，不合规直接 `ok:false`。AI 只给参数和文案。
- **限流**：全局 `exchange.maxPerMinute`（默认 30），滑动 60 秒窗口，超了 429。
- **日志**：`<服务器目录>\ops\data\mc-exchange.log`，一行一单记 task、耗时、有没有做过 JSON 提取、成功还是失败，不记玩家原话和完整模型输出。

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `exchange.enabled` | `false` | 总开关；关着时路由 404，不建会话、不花 token |
| `exchange.timeoutSeconds` | `20` | 单次请求等模型的超时（秒） |
| `exchange.maxPerMinute` | `30` | 全局限流（次/分钟） |
| `exchange.maxContextChars` | `20000` | `context` 最大字符数，超了截断 |

本地自测：

```bash
node test/mc-exchange.mjs
```

纯函数部分不需要 DSH；HTTP 部分连不上服务会全部 SKIP 并以 0 退出。`exchange.enabled=false` 时只验证「关闭时 404」和「`/mc-ai` 仍然正常」，打开后再跑一次才会跑 ping / parse 三个样例 / news / report / prospectus / government 两次 / 400 参数校验 / 429 的完整矩阵。真实模型很难稳定吐出坏 JSON，所以「坏 JSON → ok:false」由单元校验覆盖（提取、解析、schema、重试逻辑），HTTP 那格会 SKIP 并说明原因。

## 游戏内天气投票（/weather）

配套 mc-ai mod **1.2.0+**（1.3.0 起覆盖 Forge / NeoForge / Fabric / Bukkit）：游戏内所有玩家都能用 `/weather clear|rain|thunder [持续秒数]` 改天气（mod 会把原版需要 OP 的 `/weather` 换成对所有人开放）。

- 在线玩家 **≤ `weather.directThreshold`（默认 2）**：直接生效，全服提示「XX 把天气改成了下雨」
- **3 人及以上**：发起投票，发起人自动算 1 票同意；其他人在游戏里用 `/vote yes` 同意、`/vote no` 反对、`/vote status` 查看
- 同意达到 `weather.approveNeed`（默认 2）通过；反对达到 `weather.rejectNeed`（默认 1）作废；`weather.timeoutSeconds`（默认 60 秒）没结果也会作废
- 同一玩家两次发起间隔 `weather.cooldownSeconds`（默认 60 秒）
- 配置写在 `<服务器目录>/config/mcai-weather.json`，mod 每次 `/weather` 都读它，所以**设置面板改完即时生效**，不用重启服务器
- 服务器装的是旧版 mod（< 1.2.0）时，这个配置不会生效，`/weather` 也还是原版需要 OP 的版本
- **QQ 群里也能改**：玩家先用 `bind-player` 绑定游戏名并进入游戏，然后在群里跟小铜说「把天气改成下雨」即可——小铜会用你的游戏名执行 `weather`，在线 ≤2 人直接生效、≥3 人时游戏内会广播投票（其他玩家 `/vote yes`）。服主在群里说则直接执行。

## 安全模型

- 仓库和 npm 包里**不含任何口令、QQ 号、记忆数据或整合包**。
- 服主名单在 `owners.json`，只通过本机面板或命令行修改，不经过 QQ 聊天。
- 玩家默认只能读文件、跑只读命令；写文件、执行命令、联网下载需要服主授权（`ops.grantHours`）。
- 发文件到群里时，`server.properties`、`ops\data\*`、密钥类文件一律拦截。
- 游戏内 `/ai` 的附件入口只听 `127.0.0.1`，单次最多 1 个，且限制类型和大小（图片 ≤ 8MB、文件 ≤ 16MB、总 ≤ 24MB）；附件会存进 DSH home 的 attachments 存储、目前不会自动删除，文件只留只读副本，不写回玩家给的路径。
- `/mc-exchange` 默认关闭。打开后也只在本机回环口，独立会话 + 独立 system prompt，message 截断 200 字、context 截断 2 万字，全局限流 30 次/分钟、单次 20 秒超时；AI 只返回参数和文案，真正扣钱、发货、政策落地要在模组侧再校验一次。
- 设置面板的读写接口要求自定义请求头（浏览器会先发预检），跨站页面伪造不了；只改配置，不碰存档。
- `export-data` / `import-data` 仅服主可用；导入时会拒绝含 `..` 或绝对路径的压缩包条目（防 zip slip）。
- `cmd`（op/ban/kick 这类后台指令）在插件层就拦下非服主，不依赖脚本再判一次。
- `kill @a` / `kick @a` / `whitelist off` 这类“一条命令清场”的指令由静态拦截器直接拒绝，服主也发不出去；拦截在两处生效（插件层 + PowerShell 层）。
- 群服互通用到的 AppID/AppSecret 只在内存里使用，不写日志；设置里留空时才从本机 qqbot 配置读取。桥不经过 AI，群里刷屏不会消耗 token。

## 运行环境

- Windows + PowerShell 5.1（脚本用 `powershell.exe -File` 调用）
- Node.js ≥ 20（DSH 自带）
- DSH ≥ 0.2.0（`package.json` 里用 `engines.dsh` 声明，安装时会校验）

**服务端不限类型**，插件只看端口、RCON 和进程，不假设你跑的是哪一家：

| 类型 | 例子 | 识别方式 |
| --- | --- | --- |
| 插件服 | Paper / Spigot / Purpur / Folia / Leaves | 根目录 `*.jar` |
| 模组服 | Forge / NeoForge / Fabric / Quilt | `libraries/**/win_args.txt` 或 `fabric-server-launch.jar` |
| 混合服 | Arclight / Mohist / Cardboard / Youer / Banner | 走它自己的 `win_args.txt` 或启动 jar |
| 原版 | vanilla `server.jar` | 根目录 `*.jar` |
| 脚本启动 | 任意 `run.bat` | 前两者都没有时兜底执行 |

启动顺序：`libraries/**/win_args.txt` → 优先的 loader jar（fabric/quilt）→ 根目录最新 `*.jar` → `run.bat`。
内存和 JVM 参数：存在 `user_jvm_args.txt` 就自动带上（`@user_jvm_args.txt`），否则用服务端默认。

TPS 也是按服务端自动探测：`forge tps` → `tps`（Paper/Spigot）→ `spark tps` → `carpet tps`，都没有就显示 `-`，不影响其它状态项。

需要强制指定时可以设环境变量：`MC_JAR`（指定 jar）、`MC_JVM_ARGS`（覆盖 JVM 参数）、`MC_LAUNCH_ARGS`（覆盖整条启动参数）、`MC_SERVER_DIR`（服务器目录）。

## 进程检测（多层降级）

状态里的「运行」按下面这个顺序判断，任何一层可用就行，并在输出里标明用了哪层：

1. `ops\data\server.pid` + `tasklist` 校验进程名（最准，能拿到 pid）
2. 命令行匹配服务器目录：`wmic` → PowerShell `Get-CimInstance` → Linux `/proc`
3. 端口探测：直接连 `server-port`（默认 25565），能连上就认为服务活着

输出示例：`pid: 7544（pidfile）`、`pid: -（端口探测）`。两层都拿不到才算「未运行」，不会静默误报。

没有引入第三方原生进程模块（`windows-process-tree` 这类）：它们要按 Node ABI 预编译、随 Node 升级失效，供应链风险也高；端口探测已经能在「wmic 被移除 + pid 文件丢失」这种极端情况下给出正确判断。

## 数据迁移

运行期数据都在 `<服务器目录>\ops\data\`（绑定、投票、服主名单、投票门槛）。换机器或换目录时用两个工具动作搬运：

- `mc_server export-data`，arg 为目标 zip 路径 → 打包整个 `ops\data`
- `mc_server import-data`，arg 为 zip 路径 → 解压覆盖回 `ops\data`

两个动作都只有服主能调用。

## 路线图 / 已知限制

- **跨平台**：核心已抽到纯 Node 的 `ops/rcon.mjs`。`status` / `players` / `say` / `cmd` / `logs` / `start` / `stop` / `restart` 在 Linux、macOS 上直接可用（Windows 仍走 PowerShell，CPU 等指标更全）。还剩投票、白名单、绑定、KubeJS 这些写数据的动作只在 Windows 上；在别的平台调用会明确提示，而不是报 PowerShell 找不到。
- **投票超时**：已实现。`vote.timeoutMinutes`（默认 15）到点没凑够门槛会自动标成 `expired`，不再占「同时最多 3 个待确认投票」的名额。
- **人设注入范围**：按会话 id 前缀判断（`session-*` 是本机界面），是启发式；如果 DSH 以后改会话 id 规则，这里要跟着调。

## FAQ

**这是什么？**
一个 DSH 插件，让服主和群友在 QQ 群里直接管理 Minecraft 服务器：查状态、启停、绑白名单、投票授权、群服互通。

**支持哪些服务端？**
Paper / Spigot / Purpur / Folia / Leaves、Forge / NeoForge / Fabric / Quilt、Arclight / Mohist / Cardboard / Youer / Banner、vanilla，以及任意 `run.bat` 启动的服。插件只看端口、RCON 和进程，不假设服务端类型。

**需要公网 IP 吗？**
不需要。插件在本机连 RCON（默认 25575）和读日志，服务器不用暴露到公网；QQ 侧走官方机器人 API。

**安全吗？群友会不会乱来？**
三层：静态命令拦截（`kill @a`、`whitelist off` 这类谁都发不了）、投票放行（动 world / ops\data / 白名单要 2 位群友同意，凑不满前 1 票反对就作废）、服主名单（高危操作只有名单里的 QQ 能做）。拦截在插件层和 PowerShell 层各生效一次。

**支持 Linux / macOS 吗？**
只读操作和启停已经跨平台（`ops/rcon.mjs` 是纯 Node）；投票、白名单、绑定、KubeJS 这些写数据的动作还在 Windows 上，在别的平台调用会明确提示，不会报「找不到 PowerShell」。

**和 Pterodactyl 面板什么关系？**
`adapter=panel` 时，start / stop / restart / cmd 走 Pterodactyl 客户端 API；只读操作不经过适配器。要接 Pelican / AMP / PufferPanel 只需再写一个适配器文件。

**群服互通会消耗 token 吗？**
不会。桥直接读日志、直接调 QQ 开放平台，不创建 agent 会话、不调模型。只有群友真的问问题时才走 AI。

**游戏内 /ai 需要什么？**
这个插件 + 配套的 mc-ai mod [dsh-mc-ai-chat](https://github.com/mogutofu/dsh-mc-ai-chat)，服务端装 mod 后重启即可。`/ai` 会创建 agent 会话、调用 DSH 的模型，按模型计费；玩家和群友受同一套权限守卫，不能借它绕过服务器管理规则。

**游戏内 /ai 能发图片和文件吗？**
能，需要 mod 1.1.0：`/ai screenshot` 发当前游戏截图，`/ai file <路径>` 发玩家本机文件（1.1.0 一次最多 1 个附件）。图片会直接给模型看，文件落到 DSH 的附件存储后由 agent 自己读取；两条路都按上面的大小/类型限制校验，模型和 agent 因此能看到你发的内容。Bukkit 版插件只有文字 `/ai`，没有附件。

**`/mc-exchange` 是什么？**
给 AIMCmarket 模组用的严格 JSON 接口，默认关闭。打开后 DSH 会用独立会话回答解析、新闻、财报、招股书和政策请求，只回 JSON；关着时这个路由 404，不建会话也不花 token。普通 `/ai` 和群聊不受影响。

## License

MIT
