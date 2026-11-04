window.__ModuleLoader__.load({
	id: "dsh-mc-server-ops",
	factory: (require) => {
		const react = require("react")
		const h = react.createElement
		const PACKAGE_NAME = "dsh-mc-server-ops"
		const ENDPOINT = "/mc-ops/config"

		const box = { display: "flex", flexDirection: "column", gap: 10 }
		const row = { display: "flex", flexDirection: "column", gap: 4 }
		const labelStyle = { fontSize: 12, fontWeight: 600, opacity: 0.85 }
		const hintStyle = { fontSize: 11, opacity: 0.6, lineHeight: 1.5 }
		const inputStyle = {
			width: "100%",
			boxSizing: "border-box",
			padding: "6px 8px",
			borderRadius: 6,
			border: "1px solid rgba(127,127,127,0.35)",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: 13,
		}
		const textareaStyle = Object.assign({}, inputStyle, { minHeight: 120, fontFamily: "inherit", resize: "vertical" })
		const groupStyle = { border: "1px solid rgba(127,127,127,0.22)", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }
		const titleStyle = { fontSize: 13, fontWeight: 700, marginBottom: 2 }
		const buttonStyle = { padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.35)", background: "rgba(127,127,127,0.12)", color: "inherit", cursor: "pointer", fontSize: 13 }
		const statusStyle = { fontSize: 12, opacity: 0.75 }

		function Field({ label, hint, children }) {
			return h("label", { style: row }, h("span", { style: labelStyle }, label), children, hint ? h("span", { style: hintStyle }, hint) : null)
		}

		function TextInput({ value, onChange, placeholder }) {
			return h("input", { style: inputStyle, value: value == null ? "" : String(value), placeholder: placeholder || "", onChange: (e) => onChange(e.target.value) })
		}

		function NumberInput({ value, onChange }) {
			return h("input", { style: inputStyle, type: "number", value: value == null ? "" : String(value), onChange: (e) => onChange(e.target.value === "" ? "" : Number(e.target.value)) })
		}

		function Toggle({ value, onChange, label }) {
			return h("label", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" } },
				h("input", { type: "checkbox", checked: !!value, onChange: (e) => onChange(e.target.checked) }),
				label)
		}

		function ConfigPanel() {
			const [status, setStatus] = react.useState({ loading: true, error: "", saved: "", saving: false })
			const [form, setForm] = react.useState(null)
			const [owners, setOwners] = react.useState([])
			const [bridgeState, setBridgeState] = react.useState(null)
			const [newOwner, setNewOwner] = react.useState("")

			react.useEffect(() => { void load() }, [])

			async function load() {
				try {
					const res = await fetch(ENDPOINT, { cache: "no-store", headers: { "x-mc-ops-client": "1" } })
					const data = await res.json()
					if (!res.ok) throw new Error(data.error || ("HTTP " + res.status))
					const v = data.value || {}
					setForm({
						server: { dir: (v.server || {}).dir || "", rconPort: (v.server || {}).rconPort ?? 25575, rconPassword: (v.server || {}).rconPassword || "" },
						persona: { enabled: (v.persona || {}).enabled !== false, name: (v.persona || {}).name || "", text: (v.persona || {}).text || "", scope: (v.persona || {}).scope || "qq" },
						ops: {
							allowPlayerWrite: (v.ops || {}).allowPlayerWrite !== false,
							grantHours: (v.ops || {}).grantHours ?? 12,
							riskApprovalSeconds: (v.ops || {}).riskApprovalSeconds ?? 30,
						},
						adapter: v.adapter === "panel" ? "panel" : "local",
						panel: {
							url: (v.panel || {}).url || "",
							serverId: (v.panel || {}).serverId || "",
							clientApiKey: (v.panel || {}).clientApiKey || "",
						},
						bridge: {
							enabled: (v.bridge || {}).enabled === true,
							mode: (v.bridge || {}).mode || "auto",
							groups: Array.isArray((v.bridge || {}).groups) ? (v.bridge || {}).groups.join(", ") : "",
							appId: (v.bridge || {}).appId || "",
							appSecret: (v.bridge || {}).appSecret || "",
							events: {
								join: ((v.bridge || {}).events || {}).join !== false,
								leave: ((v.bridge || {}).events || {}).leave !== false,
								death: ((v.bridge || {}).events || {}).death === true,
							},
							coalesceMs: (v.bridge || {}).coalesceMs ?? 3000,
							maxPerDay: (v.bridge || {}).maxPerDay ?? 900,
						},
						vote: {
							approveNeed: (v.vote || {}).approveNeed ?? 2,
							rejectNeed: (v.vote || {}).rejectNeed ?? 1,
							timeoutMinutes: (v.vote || {}).timeoutMinutes ?? 15,
							vetoEnabled: (v.vote || {}).vetoEnabled !== false,
							protectedPaths: Array.isArray((v.vote || {}).protectedPaths) && (v.vote || {}).protectedPaths.length
								? (v.vote || {}).protectedPaths.join(", ")
								: "world, ops/data, whitelist",
						},
						permissions: {
							voteEscalation: (v.permissions || {}).voteEscalation !== false,
							kubejsEdit: (v.permissions || {}).kubejsEdit !== false,
							configEdit: (v.permissions || {}).configEdit !== false,
							playerStart: (v.permissions || {}).playerStart !== false,
							playerRestart: (v.permissions || {}).playerRestart !== false,
							playerStop: (v.permissions || {}).playerStop === true,
							gamemodeSwitch: (v.permissions || {}).gamemodeSwitch !== false,
							say: (v.permissions || {}).say !== false,
							fileSend: (v.permissions || {}).fileSend !== false,
						},
					})
					setOwners(Array.isArray(data.owners) ? data.owners : [])
					setBridgeState(data.bridgeState || null)
					setStatus({ loading: false, error: "", saved: "", saving: false })
				} catch (err) {
					setStatus({ loading: false, error: String(err && err.message ? err.message : err), saved: "", saving: false })
				}
			}

			function patch(group, key, value) {
				setForm((prev) => (prev ? Object.assign({}, prev, { [group]: Object.assign({}, prev[group], { [key]: value }) }) : prev))
			}

			// 顶层字段（adapter 这种不是对象的）单独一个入口
			function setTop(key, value) {
				setForm((prev) => (prev ? Object.assign({}, prev, { [key]: value }) : prev))
			}

			// bridge 里还嵌着 events，单独给两个入口
			function patchBridge(key, value) {
				setForm((prev) => (prev ? Object.assign({}, prev, { bridge: Object.assign({}, prev.bridge, { [key]: value }) }) : prev))
			}
			function patchBridgeEvent(key, value) {
				setForm((prev) => (prev ? Object.assign({}, prev, {
					bridge: Object.assign({}, prev.bridge, { events: Object.assign({}, prev.bridge.events, { [key]: value }) }),
				}) : prev))
			}

			async function save() {
				if (!form) return
				setStatus(Object.assign({}, status, { saving: true, error: "", saved: "" }))
				try {
					const res = await fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json", "x-mc-ops-client": "1" },
						body: JSON.stringify(form),
					})
					const data = await res.json()
					if (!res.ok) throw new Error(data.error || ("HTTP " + res.status))
					setStatus({ loading: false, error: "", saved: "已保存，马上生效", saving: false })
				} catch (err) {
					setStatus({ loading: false, error: String(err && err.message ? err.message : err), saved: "", saving: false })
				}
			}

			async function submitOwner(kind, value) {
				setStatus(Object.assign({}, status, { saving: true, error: "", saved: "" }))
				try {
					const payload = Object.assign({}, form || {})
					payload[kind] = value
					const res = await fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json", "x-mc-ops-client": "1" },
						body: JSON.stringify(payload),
					})
					const data = await res.json()
					if (!res.ok) throw new Error(data.error || ("HTTP " + res.status))
					setOwners(Array.isArray(data.owners) ? data.owners : owners)
					setNewOwner("")
					setStatus({ loading: false, error: "", saved: kind === "addOwner" ? "已添加服主" : "已移除", saving: false })
				} catch (err) {
					setStatus({ loading: false, error: String(err && err.message ? err.message : err), saved: "", saving: false })
				}
			}

			if (status.loading) return h("div", { style: hintStyle }, "正在读取配置…")
			if (status.error && !form) return h("div", { style: { color: "#d9534f", fontSize: 13 } }, "读取失败：" + status.error)
			if (!form) return null

			return h("div", { style: box },
				h("div", null,
					h("div", { style: titleStyle }, "服主绑定"),
					h("div", { style: hintStyle }, "填 QQ 号（openid）加服主。不知道自己 ID：在群里 @ 机器人 说「我的 ID 是多少」，它会把你消息开头 [昵称 (ID)] 里那串念给你。"),
				),
				h("div", { style: groupStyle },
					h("div", { style: { borderTop: "1px solid rgba(127,127,127,0.22)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 } },
						h("div", { style: labelStyle }, "服主名单（" + owners.length + "）"),
						owners.length
							? owners.map((id) => h("div", { key: id, style: { display: "flex", alignItems: "center", gap: 10 } },
								h("code", { style: { fontSize: 12, opacity: 0.85 } }, id),
								h("button", { type: "button", style: Object.assign({}, buttonStyle, { padding: "3px 10px", fontSize: 12 }), onClick: () => void submitOwner("removeOwner", id), disabled: status.saving }, "移除")))
							: h("div", { style: hintStyle }, "还没有服主。在下面填 QQ 号加一个。"),
						h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
							h("input", { style: Object.assign({}, inputStyle, { flex: "1 1 260px" }), value: newOwner, placeholder: "群消息里 [昵称 (ID)] 括号中的那串", onChange: (e) => setNewOwner(e.target.value) }),
							h("button", { type: "button", style: buttonStyle, onClick: () => void submitOwner("addOwner", newOwner.trim()), disabled: status.saving || newOwner.trim().length < 8 }, "添加为服主")),
						h("div", { style: hintStyle }, "面板在本机操作，等价于在服务器上执行 owner-add，不需要口令。"),
					),
				),
				h("div", null,
					h("div", { style: titleStyle }, "服务器"),
					h("div", { style: hintStyle }, "Minecraft 服务器目录与 RCON。改完即时生效，无需重启。"),
				),
				h("div", { style: groupStyle },
					h(Field, { label: "服务器目录", hint: "含 server.properties、mods、java 子目录的路径，例如 D:\\server" },
						h(TextInput, { value: form.server.dir, placeholder: "D:\\server", onChange: (x) => patch("server", "dir", x) })),
					h(Field, { label: "RCON 端口" },
						h(NumberInput, { value: form.server.rconPort, onChange: (x) => patch("server", "rconPort", x) })),
					h(Field, { label: "RCON 密码", hint: "留空则从 server.properties 里读取" },
						h(TextInput, { value: form.server.rconPassword, placeholder: "留空 = 自动读取", onChange: (x) => patch("server", "rconPassword", x) })),
					h(Field, { label: "注入范围" },
						h("select", { style: inputStyle, value: form.persona.scope, onChange: (e) => patch("persona", "scope", e.target.value) },
							h("option", { value: "qq" }, "只注入 QQ 群/私聊"),
							h("option", { value: "all" }, "所有会话"),
							h("option", { value: "none" }, "关闭人设注入"))),
				),
				h("div", null,
					h("div", { style: titleStyle }, "连接方式"),
					h("div", { style: hintStyle }, "启停和后台指令走哪条路。服务器就在这台机器上选「本机」；托管在翼龙面板上选「Pterodactyl」。状态、日志这些只读操作不受影响。"),
				),
				h("div", { style: groupStyle },
					h(Field, { label: "写操作走哪里" },
						h("select", { style: inputStyle, value: form.adapter, onChange: (e) => setTop("adapter", e.target.value) },
							h("option", { value: "local" }, "本机（直接跑脚本，默认）"),
							h("option", { value: "panel" }, "Pterodactyl 面板（HTTP API）"))),
					form.adapter === "panel"
						? h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
							h(Field, { label: "面板地址", hint: "例如 https://panel.example.com，不要带结尾斜杠" },
								h(TextInput, { value: form.panel.url, placeholder: "https://…", onChange: (x) => patch("panel", "url", x) })),
							h(Field, { label: "服务器 ID", hint: "面板里这台服务器 URL 的最后一段（8 位短 ID）" },
								h(TextInput, { value: form.panel.serverId, placeholder: "a1b2c3d4", onChange: (x) => patch("panel", "serverId", x) })),
							h(Field, { label: "客户端 API Key", hint: "面板 → Account → API Credentials 生成，ptlc_ 开头" },
								h(TextInput, { value: form.panel.clientApiKey, placeholder: "ptlc_…", onChange: (x) => patch("panel", "clientApiKey", x) })))
						: h("div", { style: hintStyle }, "当前用本机脚本启停，不需要面板配置。"),
				),
				h("div", null,
					h("div", { style: titleStyle }, "人设"),
					h("div", { style: hintStyle }, "默认是小铜。改名字和语气只需要改这里，代码不用动。"),
				),
				h("div", { style: groupStyle },
					h(Toggle, { label: "启用自定义人设", value: form.persona.enabled, onChange: (x) => patch("persona", "enabled", x) }),
					h(Field, { label: "名字" },
						h(TextInput, { value: form.persona.name, placeholder: "小铜", onChange: (x) => patch("persona", "name", x) })),
					h(Field, { label: "人设正文", hint: "留空则使用内置的小铜设定；写得越具体，语气越稳。" },
						h("textarea", { style: textareaStyle, value: form.persona.text, placeholder: "你在 QQ 群里叫「小铜」，二十来岁……", onChange: (e) => patch("persona", "text", e.target.value) })),
				),
				h("div", null,
					h("div", { style: titleStyle }, "权限"),
					h("div", { style: hintStyle }, "玩家能做什么、服主授权窗口多长。受保护区域（world、ops\\data、白名单）始终要投票。"),
				),
				h("div", { style: groupStyle },
					h(Toggle, { label: "允许玩家改服务器目录下的普通文件（kubejs/config 等）", value: form.ops.allowPlayerWrite, onChange: (x) => patch("ops", "allowPlayerWrite", x) }),
					h(Field, { label: "服主授权窗口（小时）", hint: "服主确认后，该会话可以改文件、执行命令的时长" },
						h(NumberInput, { value: form.ops.grantHours, onChange: (x) => patch("ops", "grantHours", x) })),
					h(Field, { label: "创建服主口令冷却（秒）" },
						h(NumberInput, { value: form.ops.riskApprovalSeconds, onChange: (x) => patch("ops", "riskApprovalSeconds", x) })),
				),
				h("div", null,
					h("div", { style: titleStyle }, "投票"),
					h("div", { style: hintStyle }, "改 world / ops\\data / 白名单 这类受保护区域时走的流程。"),
				),
				h("div", { style: groupStyle },
					h(Field, { label: "通过需要几位同意", hint: "默认 2 位" },
						h(NumberInput, { value: form.vote.approveNeed, onChange: (x) => patch("vote", "approveNeed", x) })),
					h(Field, { label: "几位反对就作废", hint: "默认 1，也就是一票否决；改成 2 就要两个人反对才作废" },
						h(NumberInput, { value: form.vote.rejectNeed, onChange: (x) => patch("vote", "rejectNeed", x) })),
					h(Field, { label: "多久没凑够自动作废（分钟）", hint: "默认 15 分钟；到点没满票就变成「已过期」，不再占用待确认名额" },
						h(NumberInput, { value: form.vote.timeoutMinutes, onChange: (x) => patch("vote", "timeoutMinutes", x) })),
					h(Toggle, { label: "允许一票否决（凑够同意票之前有人反对就作废）", value: form.vote.vetoEnabled, onChange: (x) => patch("vote", "vetoEnabled", x) }),
					h(Field, { label: "受保护路径", hint: "逗号分隔，改动这些位置要走投票。默认 world, ops/data, whitelist" },
						h(TextInput, { value: form.vote.protectedPaths, placeholder: "world, ops/data, whitelist", onChange: (x) => patch("vote", "protectedPaths", x) })),
				),
				h("div", null,
					h("div", { style: titleStyle }, "群服互通"),
					h("div", { style: hintStyle }, "把游戏内聊天直接转发到 QQ 群。走机器人自己的接口，不经过 AI、不消耗 token。"),
				),
				h("div", { style: groupStyle },
					bridgeState
						? h("div", { style: Object.assign({}, hintStyle, { color: bridgeState.running ? "#3c9a5f" : "#d9534f" }) },
							(bridgeState.running ? "● 运行中" : "○ 未运行")
							+ " · 在线 " + ((bridgeState.online || []).length) + " 人"
							+ " · 今日已发 " + (bridgeState.sentToday || 0) + " 条"
							+ (bridgeState.lastError ? " · ⚠ " + bridgeState.lastError : ""))
						: null,
					h(Toggle, { label: "启用群服互通", value: form.bridge.enabled, onChange: (x) => patchBridge("enabled", x) }),
					h(Field, { label: "运行模式", hint: "auto 只有人玩的时候才转发（推荐）；on 一直转发；off 完全关闭" },
						h("select", { style: inputStyle, value: form.bridge.mode, onChange: (e) => patchBridge("mode", e.target.value) },
							h("option", { value: "auto" }, "有玩家时开启（默认）"),
							h("option", { value: "on" }, "常开启"),
							h("option", { value: "off" }, "常关闭"))),
					h(Field, { label: "转发到哪些群", hint: "群 openid，逗号分隔。不知道的话在群里 @ 小铜 问" },
						h(TextInput, { value: form.bridge.groups, placeholder: "FC73DE60… ", onChange: (x) => patchBridge("groups", x) })),
					h(Field, { label: "除聊天外还转发", hint: "聊天内容始终转发" },
						h("div", { style: { display: "flex", gap: 18, flexWrap: "wrap" } },
							h(Toggle, { label: "玩家加入", value: form.bridge.events.join, onChange: (x) => patchBridgeEvent("join", x) }),
							h(Toggle, { label: "玩家离开", value: form.bridge.events.leave, onChange: (x) => patchBridgeEvent("leave", x) }),
							h(Toggle, { label: "死亡消息", value: form.bridge.events.death, onChange: (x) => patchBridgeEvent("death", x) }))),
					h(Field, { label: "合并窗口（毫秒）", hint: "这段时间内的多条游戏消息合成一条 QQ 消息，默认 3000" },
						h(NumberInput, { value: form.bridge.coalesceMs, onChange: (x) => patchBridge("coalesceMs", x) })),
					h(Field, { label: "每群每天发送上限", hint: "官方上限 1000 条/天，默认 900 留余量" },
						h(NumberInput, { value: form.bridge.maxPerDay, onChange: (x) => patchBridge("maxPerDay", x) })),
					h(Field, { label: "AppID", hint: "留空自动从本机 qqbot 配置读取，一般不用填" },
						h(TextInput, { value: form.bridge.appId, placeholder: "留空 = 自动", onChange: (x) => patchBridge("appId", x) })),
					h(Field, { label: "AppSecret", hint: "同上，留空自动读" },
						h(TextInput, { value: form.bridge.appSecret, placeholder: "留空 = 自动", onChange: (x) => patchBridge("appSecret", x) })),
				),
				h("div", null,
					h("div", { style: titleStyle }, "功能开关"),
					h("div", { style: hintStyle }, "逐项决定群友能做什么。关掉的那一项，玩家调用会被直接拒绝（服主不受影响）。"),
				),
				h("div", { style: groupStyle },
					h(Toggle, { label: "投票放权（改 world / ops\\data / 白名单）", value: form.permissions.voteEscalation, onChange: (x) => patch("permissions", "voteEscalation", x) }),
					h(Toggle, { label: "允许玩家改 KubeJS 配方（kubejs/）", value: form.permissions.kubejsEdit, onChange: (x) => patch("permissions", "kubejsEdit", x) }),
					h(Toggle, { label: "允许玩家改 config / defaultconfigs / server.properties", value: form.permissions.configEdit, onChange: (x) => patch("permissions", "configEdit", x) }),
					h(Toggle, { label: "服务器关闭时允许玩家开服", value: form.permissions.playerStart, onChange: (x) => patch("permissions", "playerStart", x) }),
					h(Toggle, { label: "服务器崩溃/假死时允许玩家重启", value: form.permissions.playerRestart, onChange: (x) => patch("permissions", "playerRestart", x) }),
					h(Toggle, { label: "允许玩家停服", value: form.permissions.playerStop, onChange: (x) => patch("permissions", "playerStop", x) }),
					h(Toggle, { label: "允许玩家切自己的游戏模式", value: form.permissions.gamemodeSwitch, onChange: (x) => patch("permissions", "gamemodeSwitch", x) }),
					h(Toggle, { label: "允许玩家游戏内广播（say）", value: form.permissions.say, onChange: (x) => patch("permissions", "say", x) }),
					h(Toggle, { label: "允许玩家把文件发到群里", value: form.permissions.fileSend, onChange: (x) => patch("permissions", "fileSend", x) }),
				),
				h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
					h("button", { type: "button", style: buttonStyle, onClick: () => void save(), disabled: status.saving }, status.saving ? "保存中…" : "保存"),
					h("button", { type: "button", style: buttonStyle, onClick: () => void load(), disabled: status.saving }, "重新读取"),
					status.saved ? h("span", { style: Object.assign({}, statusStyle, { color: "#3c9a5f" }) }, status.saved) : null,
					status.error ? h("span", { style: Object.assign({}, statusStyle, { color: "#d9534f" }) }, status.error) : null,
				),
			)
		}

		function PageBody() {
			return h("div", { style: { padding: "16px 4px", maxWidth: 720 } },
				h("div", { style: { fontSize: 18, fontWeight: 700, marginBottom: 4 } }, "Minecraft 服务器"),
				h("div", { style: Object.assign({}, hintStyle, { marginBottom: 14 }) }, "改完即时生效。受保护区域（world、ops\\data、白名单）仍然要两位群友投票，这里改不了。"),
				h(ConfigPanel),
			)
		}

		function apply(ctx) {
			const slots = ctx.slots
			if (slots === void 0) return
			// 1) 插件详情页里的配置块
			ctx.effect(() => slots.inject("plugins.bundle.config", () => slots.register({
				name: "plugins.bundle.config",
				key: PACKAGE_NAME,
			}, ConfigPanel)))
			// 2) 设置左侧独立入口（和「QQ 机器人」并列），保证一定看得见
			ctx.effect(() => slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "mc-server-ops",
				order: 9,
				label: "MC 服务器",
			}, PageBody)))
		}

		const inject = ["slots"]
		const name = "mc-server-ops-client"
		const exportsObj = { apply, inject, name }
		return exportsObj
	}
});
