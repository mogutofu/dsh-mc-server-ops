# dsh-mc-server-ops

[![npm version](https://img.shields.io/npm/v/dsh-mc-server-ops.svg)](https://www.npmjs.com/package/dsh-mc-server-ops)
[![npm downloads](https://img.shields.io/npm/dm/dsh-mc-server-ops.svg)](https://www.npmjs.com/package/dsh-mc-server-ops)
[![license](https://img.shields.io/npm/l/dsh-mc-server-ops.svg)](https://github.com/mogutofu/dsh-mc-server-ops/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.0-blue)](https://github.com/deepseek-ai)

**在 QQ 群里管理 Minecraft 服务器。** 服主不用开电脑、不用记命令——群里发一句话，就能查状态、启停服务器、绑白名单、投票授权；游戏聊天还能直通 QQ 群，不经过 AI、不耗 token。

> 当前版本 **0.5.2** · 更新于 **2026-11-07** · 以本页和 [npm](https://www.npmjs.com/package/dsh-mc-server-ops) 为准

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
- **游戏内 AI**：装上配套 Forge mod 后，玩家在游戏里 `/ai <内容>` 就能和「小铜」对话（只监听 `127.0.0.1`，按玩家 UUID 复用独立会话）

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
当前版本号为 0.5.1                        [检查更新]
[新版本 v0.6.0]                           [检查更新]
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
| `bridge.groups` | `[]` | 转发到哪些群（群 openid） |
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
| `ai.enabled` | `true` | 是否开游戏内 `/ai` 对话（需要配套 Forge mod；只监听 `127.0.0.1`） |
| `ai.port` | `8765` | mod 连接的本地端口 |
| `ai.timeoutSeconds` | `60` | 等 AI 回复的超时秒数 |

## 目录结构

```
dsh-mc-server-ops/
├── index.js            # 插件宿主代码：mc_server 工具、权限守卫、人设注入
├── cordis.patch.yml    # 安装时自动插入的加载行
└── ops/
    ├── command-guard.mjs   # 静态命令拦截：出网前掐掉“一条命令搞崩整个服”的类型
    ├── qq-bridge.mjs       # 群服互通：读日志 → 直连 QQ 开放平台（不经过 AI）
    ├── coalesce.mjs        # 合并窗口计算：最近发言节奏 + 在线人数 → 等多久再发（纯函数）
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

群 openid 不知道怎么办：官方没有「列出机器人加入的群」的稳定接口（`/v2/users/@me/groups` 直接 404），只能从一条真实的群消息里抓一次。详细过程写在 [docs/qq-bridge.md](https://github.com/mogutofu/dsh-mc-server-ops/blob/main/docs/qq-bridge.md)。

## 游戏内 AI 对话（/ai）

配套 Forge mod：[mogutofu/dsh-mc-ai-chat](https://github.com/mogutofu/dsh-mc-ai-chat)（服务端 Forge 1.20.1-47.x）。玩家在游戏里输入 `/ai 你好`，mod 会把请求 POST 到本机 `127.0.0.1:8765/mc-ai`，插件开一个 agent 回合，再把回复贴回玩家聊天栏。

| 项 | 说明 |
| --- | --- |
| 监听 | 只听 `127.0.0.1`，公网进不来；端口默认 8765 |
| 会话 | 每个玩家 UUID 一个会话 `mc-ai:<uuid>`，上下文连续；不是本机界面会话，按「群友」权限管 |
| 协议 | `POST /mc-ai`，请求 JSON `{"player":"名字","uuid":"UUID","text":"内容"}` → 回复 `{"ok":true,"reply":"…"}`；HTTP 200 也可能是 `ok:false`，以 `ok` 字段为准 |
| 配置 | `ai.enabled` / `ai.port` / `ai.timeoutSeconds`，改完立刻生效 |
| 排障 | 回复「（小铜没说话）」通常是 agent 没拿到可用的模型路由：检查 DSH 的默认模型（`agentDefaultModel`）是否指向有效 provider；`<服务器目录>\ops\data\mc-ai.log` 会记录每次请求和真实错误 |

游戏内玩家和群友一样受权限守卫限制：只读查询可以，写文件、执行命令需要服主授权；mod 侧默认每玩家 5 秒冷却，避免刷屏。

## 安全模型

- 仓库和 npm 包里**不含任何口令、QQ 号、记忆数据或整合包**。
- 服主名单在 `owners.json`，只通过本机面板或命令行修改，不经过 QQ 聊天。
- 玩家默认只能读文件、跑只读命令；写文件、执行命令、联网下载需要服主授权（`ops.grantHours`）。
- 发文件到群里时，`server.properties`、`ops\data\*`、密钥类文件一律拦截。
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
这个插件 + 配套的 Forge mod [dsh-mc-ai-chat](https://github.com/mogutofu/dsh-mc-ai-chat)，服务端装 mod 后重启即可。`/ai` 会创建 agent 会话、调用 DSH 的模型，按模型计费；玩家和群友受同一套权限守卫，不能借它绕过服务器管理规则。

## License

MIT
