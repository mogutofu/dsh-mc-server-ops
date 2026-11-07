# Changelog

版本号对应 git tag `vX.Y.Z`。

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
