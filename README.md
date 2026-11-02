# dsh-mc-server-ops

把一台 **Minecraft 服务器**托管到 [DeepSeek Harness](https://github.com/deepseek-ai) 里的插件：QQ 群里的群友可以直接查状态、看日志、绑定游戏名，服主可以启停服务器、改配置、修 KubeJS 配方。

> 插件本身只是「服务器操作 + 人设」这一层，**聊天通道由 QQ 机器人插件提供**。
> 安装前请先装好并配置 `@tencent-connect/dsh-qqbot`（见下方「前置插件」），否则装上了也没有入口。

## 前置插件（必须）

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

## 目录结构

```
dsh-mc-server-ops/
├── index.js            # 插件宿主代码：mc_server 工具、权限守卫、人设注入
├── cordis.patch.yml    # 安装时自动插入的加载行
└── ops/
    ├── rcon.mjs             # 跨平台核心：RCON、进程探测、日志、状态汇总
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

投票门槛也能改：`vote.approveNeed`（默认 2 位同意）和 `vote.rejectNeed`（默认 1 位反对即作废；改成 2 就要两个人反对才作废）。保存后会写进 `ops\data\vote-config.json`，脚本每次调用时读它。

## 安全模型

- 仓库和 npm 包里**不含任何口令、QQ 号、记忆数据或整合包**。
- 服主名单在 `owners.json`，只通过本机面板或命令行修改，不经过 QQ 聊天。
- 玩家默认只能读文件、跑只读命令；写文件、执行命令、联网下载需要服主授权（`ops.grantHours`）。
- 发文件到群里时，`server.properties`、`ops\data\*`、密钥类文件一律拦截。
- 设置面板的读写接口要求自定义请求头（浏览器会先发预检），跨站页面伪造不了；只改配置，不碰存档。
- `export-data` / `import-data` 仅服主可用；导入时会拒绝含 `..` 或绝对路径的压缩包条目（防 zip slip）。
- `cmd`（op/ban/kick 这类后台指令）在插件层就拦下非服主，不依赖脚本再判一次。

## 运行环境

- Windows + PowerShell 5.1（脚本用 `powershell.exe -File` 调用）
- Node.js ≥ 20（DSH 自带）

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

## License

MIT
