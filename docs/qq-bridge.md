# QQ 群 ↔ Minecraft 群服互通 · 设计草案

> 目标：真正的双向互通（不只是 `say`），可选三种运行模式，**全程不经过 AI、不烧 token**。
> 状态：**P0（游戏 → QQ）已实现并上线**；P1（QQ → 游戏）暂缓，见 §8。

---

## 1. 要解决的问题

| 需求 | 说明 |
| --- | --- |
| 双向 | 游戏内聊天 → QQ 群；QQ 群消息 → 游戏内聊天 |
| 三档模式 | `auto`（有玩家时开启，默认）/ `on`（常开）/ `off`（常关） |
| 零 token | QQ 消息不创建 agent 会话、不调模型 |
| 可选扩展 | 玩家进出、死亡、成就等事件转发 |

---

## 2. 硬约束（先看清楚再动手）

### 2.1 QQ 官方机器人

来自 [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)：

| 类型 | 规则 |
| --- | --- |
| 被动消息 | `msg_id` **5 分钟**内有效；**同一条消息最多回复 5 次** |
| 主动消息 | Bot 维度 60 qpm（已认证）/ 30 qpm（未认证）；**单群 20 qpm，且每群每天最多 1000 条** |
| 关键错误码 | `40034100` 主动消息超频控 · `40034105` 无主动消息权限 · `40054005` 消息去重（`msg_seq` 冲突）· `40054007` 超长 · `40054010` 含 URL 被拒 |

**结论**：一天 1000 条/群，小服够用，大服必然撞墙 → 必须做聚合与限流，不能一条游戏聊天发一条 QQ。

### 2.2 群消息能不能收到

- `GROUP_AT_MESSAGE_CREATE` — 只有 @机器人 的消息，**默认就有的能力**。
- `GROUP_MESSAGE_CREATE` — 群内全部消息，**需要在开放平台申请「群消息」权限**。
- DSH 的 mention-gate 目前按 `GROUP_AT_MESSAGE_CREATE` 判定"是否被 @"，非 @ 消息会被丢弃（但 `historyBuffer` 仍会记录）。

> ⚠️ **这是整个方案的第一个卡点**：没有群消息权限，QQ→游戏 只能搬 @机器人 的消息，那"互通"就名不副实。

### 2.3 DSH 侧没有入站钩子

`@tencent-connect/dsh-qqbot` 的链路：

```
QQ 网关 → bot.use(中间件链) → bot.on('message') → handleInbound() → agent.followup() → 调模型
```

- 中间件链（`bot.use`）是**唯一**能在"创建会话之前"截断的地方；
- 但 `bot` 实例是 `bootstrapGateway()` 里的局部变量，**没有挂到 ctx 上**；
- 插件也拿不到发消息的句柄（`bot.sendMarkdown(replyTarget, ...)` 同理）。

**结论**：要真正做到"不烧 token"，必须让桥接逻辑进到中间件链里 —— qqbot 得开个口子。

---

## 3. 借鉴：现成的群服互通项目怎么做的

| 项目 | 数据来源 | 值得抄的地方 |
| --- | --- | --- |
| [17TheWord/nonebot-plugin-mcqq](https://github.com/17TheWord/nonebot-plugin-mcqq)（140⭐，生态最全） | 配套服务端 mod [鹊桥 QueQiao](https://github.com/17TheWord/QueQiao)，WebSocket 推送结构化事件 | 有 mod 就别解析日志；把"加入/离开/聊天/死亡"拆成事件类型；QQ 侧做图片/视频降级为 `[图片]` |
| [KarisAya/nonebot_plugin_mcqq_server](https://github.com/KarisAya/nonebot_plugin_mcqq_server) | **本地读 `logs/` 文件** | 没有 mod 的整合包服只有这条路；日志轮转、编码、正则容错是重点 |
| [yuexps/endstone-qqsync-plugin](https://github.com/yuexps/endstone-qqsync-plugin) | 服务端插件钩子 | 基岩版思路，配置项设计可参考 |
| [Koob-ise/rcon-chat](https://github.com/Koob-ise/rcon-chat) | RCON | 最小可用实现：RCON 只能**发**不能**收**，收必须靠日志或 mod |

**对本服的判断**：黄铜协奏曲是 Forge 整合包，装服务端 mod 不现实（会改变玩家需要装的 mod 列表）→ **只能读日志**。这跟 KarisAya 那套一模一样。

---

## 4. Minecraft 侧

### 4.1 收（游戏 → 桥）

```
logs/latest.log 增量读取（fs.watch + 偏移量），处理每日轮转
```

正则（Forge / 原版通用）：

```
\[Server thread/INFO\]: <(\w{1,16})> (.*)          # 聊天
\[Server thread/INFO\]: (\w{1,16}) joined the game   # 加入
\[Server thread/INFO\]: (\w{1,16}) left the game     # 离开
\[Server thread/INFO\]: (\w{1,16}) (was |drowned|blew up|...)  # 死亡（英文本地化）
```

坑位：
- 颜色码 `§x` / `\u00a7`，日志里可能带；
- Forge 的 chat 修饰（`[Not Secure]` 前缀、`<name>` 里可能有昵称符号）；
- 死亡消息是本地化的英文，只能宽松匹配，宁可漏不要错。

### 4.2 发（桥 → 游戏）

```
RCON: tellraw @a {"text":"[QQ] 昵称: 内容","color":"aqua"}
```

- 单条命令上限 256 字符 → 长消息拆多条，或截断；
- 必须做 JSON 转义（`"`、`\`、控制字符），否则整个 tellraw 崩；
- 备选 `say`（带 `[Server]` 前缀、无颜色），不推荐。

**在线判定**：RCON `list` → `There are N of a max of M players online`，5 秒缓存一次；
备选 Server List Ping（无 RCON 也能用，但本服 RCON 已开，直接用 RCON 更简单）。

### 4.3 三种模式

```
mode = auto | on | off
presence = (list 返回人数 > 0)

auto:  presence ? 转发 : 暂停（丢弃并记日志，不缓存——缓存会积压过期消息）
on:    始终转发
off:   完全停（连日志 tail 都可以不跑）
```

切模式时给群/游戏各发一条一次性提示（"群服互通已开启/暂停"），避免玩家困惑。

---

## 5. QQ 侧

### 5.1 收（QQ → 游戏）

中间件插入位置：`historyBuffer` 之后、`mentionGate` 之前（能看到所有消息，包括没 @ 的）。

分流规则：

```
/ 开头          → 交给 slashCommand（现有命令，不拦）
@机器人          → 交给 AI（现有行为，烧 token 是应该的）
其它群消息       → 进桥 → tellraw 到游戏 → 吞掉（不创建会话）
```

### 5.2 发（游戏 → QQ）

两条路：

1. **被动回复**（优先）：借最近 5 分钟内的 `msg_id` 回复，免费且不限频，但**每条最多 5 次**。
2. **主动消息**（兜底）：没有可用 `msg_id` 时直接往群里发，20 qpm / 1000 日。

**聚合策略**（必须做）：多条游戏聊天合并成一条多行消息；超长截断；撞 1000 日配额时降级为"每 30 秒合并一条"。窗口已做成自适应（最近发言节奏 + 在线人数，见 §9 的 `coalesce`），人少话稀时 1 秒左右就发。

### 5.3 防环（最容易翻车的地方）

```
游戏聊天 → QQ → 被中间件当成"群消息" → 又发回游戏 → 死循环
```

三道保险：
1. 出站消息带来源标记，入站解析时跳过带标记的；
2. 日志 tail 里过滤我们自己 tellraw 的格式（`[QQ] ` 前缀）；
3. 双向都做 message_id / hash 去重（最近 200 条）。

---

## 6. 安全与清洗

| 项目 | 处理 |
| --- | --- |
| QQ 侧 `@全体成员` | 直接剔除（防炸群） |
| 颜色码 / 控制字符 | 剥掉再发 |
| URL | 主动消息可能被拒（40054010），默认剥离或替换成 `[链接]` |
| 长度 | QQ 侧单条截断到 ~900 字；游戏侧 256 字符 |
| 频率 | 每玩家 1 条 / 2 秒，超了丢弃 |
| 群白名单 | 只桥接 `bridge.groups` 里配置的群 |
| 私聊 | 不桥接（话题语境丢失，容易误伤） |

---

## 7. 落地路线

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **P0** | 游戏 → QQ 单向：日志 tail + 直连 QQ HTTP API 主动消息（不需要 qqbot 任何改动） | 只需 appId/appSecret |
| **P1** | QQ → 游戏：需要入站钩子（见 §8） | 卡在 qqbot |
| **P2** | 事件扩展：进出、死亡、TPS 告警 | P1 之后 |
| **P3** | 面板 UI：模式切换、群白名单、开关各类事件 | — |

P0 完全独立，今天就能做，而且已经能覆盖"群友看游戏聊天"这个最大的使用场景。

---

## 8. 卡点：QQ → 游戏 需要一个钩子（三选一）

### 方案 A · 上游开钩子（最干净）

给 `@tencent-connect/dsh-qqbot` 加两行：

```js
// bootstrap.js，创建 bot 之后
ctx.set('qqbot', { bot, manager })          // 插件能拿到发消息句柄
// 或：ctx.emit('qqbot/inbound', mCtx) 支持返回 true 吞掉
```

我们插件再 `ctx.get('qqbot')` 注册中间件。缺点：要等上游合并，或者由我们给上游发 PR。

### 方案 B · 我们插件给 qqbot 打幂等补丁（今天就能用）

`apply()` 时定位 `profiles/<p>/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js`，
注入一个 bridge 中间件（带标记注释、版本校验、备份、失败回滚、幂等）。

- 优点：不依赖上游，效果和方案 A 一样；
- 缺点：**qqbot 升级会掉**，得在 apply 时重新检测重打；属于"明确告知用户的 hack"。

### 方案 C · 不碰 qqbot（能力受限）

只做 P0（游戏→QQ）+ "@机器人 的消息 → 游戏"。
好处是零风险；坏处是达不到真正的"群消息进游戏"。

> 另外还有个野路子：轮询 qqbot 内部的 `historyStore`（`recordOnSkip: true` 会记录所有消息）。
> 能跑，但依赖内部单例 + 回复后 `clearGroupHistory` 会清空，容易丢消息，**不建议**。

---

## 9. 配置项草案

```yaml
bridge:
  enabled: true
  mode: auto            # auto | on | off
  groups: []            # 目标群 openid；空 = 自动（上次记住 → 最近捕获），不会转发到未记录的群
  gameToQQ: true
  qqToGame: true
  events:               # 除聊天外还要转什么
    join: false         # 进服默认不转（刷屏）
    leave: false        # 退服默认不转
    death: true         # 死亡消息默认转
  qqPrefix: "群"         # 游戏内显示成 [群] 昵称: xxx
  gamePrefix: ""         # QQ 里显示成 玩家名: xxx
  coalesceMs: 3000       # 固定聚合窗口（coalesce.mode=fixed 时用）
  coalesce:              # 自适应聚合窗口（默认 auto）
    mode: auto           # auto | fixed
    minMs: 1000          # 冷场/人少时的最短等待
    maxMs: 6000          # 最热闹时最多攒这么久
    sampleSize: 3        # 参考最近几条发言算节奏
    quietMs: 20000       # 超过这么久没说话算冷场
    fullPlayers: 6       # 在线人数到这个值算满档
    fastMs: 2000         # 相邻两条间隔小于这个值算满活跃
  maxPerDay: 900         # 主动消息日配额保护（官方上限 1000）
```

---

## 10. 需要拍板的事

1. **群消息权限**：去开放平台确认有没有 `GROUP_MESSAGE_CREATE`（群消息）权限。没有的话，QQ→游戏 只能搬 @机器人 的那部分，方案价值大打折扣。
2. **钩子方案**：A（等上游）/ B（打补丁，今天可用）/ C（只做单向）。
3. **范围**：P0 先上，还是等 P1 一起做？

---

## 11. 实际落地记录（2026-11）

P0 按本文档实现，落在 `ops/qq-bridge.mjs`，实测通过：

- 群 openid 的获取方式：官方 `/v2/users/@me/groups` 返回 `404 不支持的调用`（`api.sgroup.qq.com` 和 `api.bot.qq.com` 都一样），所以采用「临时给 qqbot 的 `inbound.js` 加两行，把 `scope + peerId` 写进 `ops/data/qq-keys.txt`，群友 @ 一次机器人即可」的办法抓一次。抓到后永久写进配置，不再需要。
- 日志编码是 GBK（系统编码），不是 UTF-8 —— 这是本项目踩到最大的一个坑，中文会变成 `��ôţ��`。`decodeLogBytes()` 先用 UTF-8 解，出现 `U+FFFD` 自动退回 GBK。
- 主动消息发送权限正常（群里有 `<玩家> r11` 这种实测消息），20 qpm / 1000 日 的配额没有触发。
- 0.6.1 起群 openid 会持久化到 `ops/data/bridge-groups.json`：配置里的 `groups` 为空时自动回退（上次记住 → 最近捕获），重装/升级插件丢失配置不再导致群服互通沉默。`mc_server bridge-groups` 在官方接口 404 时也会回退到本地记录。