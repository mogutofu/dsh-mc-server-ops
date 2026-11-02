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
    ├── mcadmin.ps1         # 运维入口（status/start/stop/投票/白名单…）
    ├── watchdog.ps1        # 看门狗：崩溃自动拉起
    └── server-console.ps1  # 带日志着色的服务器控制台
```

首次运行时插件会把 `ops/*.ps1` 复制到 `<服务器目录>\ops\`，运行期数据（`bindings.json`、`votes.json`、`state.json`、`owners.json`）也生成在那里，**不会**写进本仓库。

## 安全模型

- 仓库和 npm 包里**不含任何口令、QQ 号、记忆数据或整合包**。
- 服主口令在 `owners.json` 里由本机生成，绑定口令写进 `ops\data\config.json`，都不外发。
- 玩家默认只能读文件、跑只读命令；写文件、执行命令、联网下载需要服主授权（`ops.grantHours`）。
- 发文件到群里时，`server.properties`、`ops\data\*`、密钥类文件一律拦截。

## 运行环境

- Windows + PowerShell 5.1（脚本用 `powershell.exe -File` 调用）
- Node.js ≥ 20（DSH 自带）
- 服务器本体：Forge/Fabric 皆可，启动参数放在 `user_jvm_args.txt`，`win_args.txt` 由脚本自动探测

## License

MIT
