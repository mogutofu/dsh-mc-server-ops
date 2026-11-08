# Changelog

版本号对应 git tag `vX.Y.Z`。

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
