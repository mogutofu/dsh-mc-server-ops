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
						vote: {
							approveNeed: (v.vote || {}).approveNeed ?? 2,
							rejectNeed: (v.vote || {}).rejectNeed ?? 1,
							timeoutMinutes: (v.vote || {}).timeoutMinutes ?? 15,
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
					setStatus({ loading: false, error: "", saved: "", saving: false })
				} catch (err) {
					setStatus({ loading: false, error: String(err && err.message ? err.message : err), saved: "", saving: false })
				}
			}

			function patch(group, key, value) {
				setForm((prev) => (prev ? Object.assign({}, prev, { [group]: Object.assign({}, prev[group], { [key]: value }) }) : prev))
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

			if (status.loading) return h("div", { style: hintStyle }, "正在读取配置…")
			if (status.error && !form) return h("div", { style: { color: "#d9534f", fontSize: 13 } }, "读取失败：" + status.error)
			if (!form) return null

			return h("div", { style: box },
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
