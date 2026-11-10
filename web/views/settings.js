import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, sorted, useStore } from "../lib/store.js";
import { Stat, Empty, Status, Switch, colorOf, navigate, sessionName, timeAgo, useTick } from "../lib/util.js";
import { ReviewModeToggle } from "./agents.js";

const NOTIFICATION_KINDS = [
	{ kind: "review", label: "Diff reviews" },
	{ kind: "question", label: "Questions" },
	{ kind: "done", label: "Agent finished" },
	{ kind: "error", label: "Agent errors" },
	{ kind: "message", label: "Messages" },
	{ kind: "test_fail", label: "Test failures" },
	{ kind: "pr", label: "Pull request updates" },
	{ kind: "conflict", label: "Edit conflicts" },
];

function withDefaults(config) {
	const base = structuredClone(config ?? {});
	base.notifications = { enabled: true, sound: true, ...(base.notifications ?? {}) };
	base.notifications.kinds = { ...Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k.kind, true])), ...(base.notifications.kinds ?? {}) };
	base.review = { autoApprove: [], contextLines: 3, ...(base.review ?? {}) };
	base.review.autoApprove = (base.review.autoApprove ?? []).map((rule) => ({ glob: "", tool: "", session: "", ...rule }));
	base.summaries = { onAgentEnd: true, minTurns: 3, ...(base.summaries ?? {}) };
	base.prPollSeconds ??= 90;
	base.openBrowserOnReview ??= true;
	base.piCommand ??= "pi";
	return base;
}

function cleanRules(rules) {
	return rules
		.filter((rule) => rule.glob?.trim())
		.map((rule) => {
			const out = { glob: rule.glob.trim() };
			if (rule.tool) out.tool = rule.tool;
			if (rule.session?.trim()) out.session = rule.session.trim();
			return out;
		});
}

function Section({ title, sub, children }) {
	return html`<div class="card glossy settings-section">
		<div style="margin-bottom:14px">
			<h3 style="font-size:16px">${title}</h3>
			${sub ? html`<div class="small faint" style="margin-top:2px">${sub}</div>` : null}
		</div>
		<div class="col" style="gap:12px">${children}</div>
	</div>`;
}

function NumberField({ label, value, min = 0, onChange, suffix }) {
	return html`<label class="row small" style="gap:10px">
		<span style="flex:1">${label}</span>
		<input class="input" type="number" min=${min} style="width:110px" value=${value} onInput=${(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
		${suffix ? html`<span class="tiny faint">${suffix}</span>` : null}
	</label>`;
}

function BrowserNotifications() {
	const supported = "Notification" in window;
	const [permission, setPermission] = useState(supported ? Notification.permission : "unsupported");
	const request = async () => {
		if (!supported) return;
		setPermission(await Notification.requestPermission());
	};
	const tone = permission === "granted" ? "ok" : permission === "denied" ? "bad" : "warn";
	return html`<div class="row small">
		<span style="flex:1">Desktop notifications when the tab is hidden</span>
		<span class=${`pill ${tone}`}>${permission}</span>
		<button class="btn sm" disabled=${!supported || permission === "granted"} onClick=${request}>Request permission</button>
	</div>`;
}

function RenameCell({ session }) {
	const [name, setName] = useState(session.name ?? "");
	const [saved, setSaved] = useState(false);
	useEffect(() => setName(session.name ?? ""), [session.name]);
	const commit = async () => {
		if (name === (session.name ?? "")) return;
		await api("POST", `/api/sessions/${encodeURIComponent(session.id)}/rename`, { name }).catch((error) => alert(error.message));
		setSaved(true);
		setTimeout(() => setSaved(false), 1200);
	};
	return html`<div class="row" style="gap:6px">
		<input
			class="input"
			style="padding:6px 10px;min-width:120px"
			value=${name}
			placeholder=${sessionName(session)}
			onInput=${(e) => setName(e.target.value)}
			onKeyDown=${(e) => e.key === "Enter" && commit()}
			onBlur=${commit}
		/>
		${saved ? html`<span class="tiny" style="color:var(--ok)">✓</span>` : null}
	</div>`;
}

function SessionsTable({ sessions }) {
	const setTrust = (session, auto) => api("POST", `/api/sessions/${encodeURIComponent(session.id)}/trust`, { mode: auto ? "auto" : "review" }).catch((error) => alert(error.message));
	const forget = async (session) => {
		if (!confirm(`Forget ${sessionName(session)}? Its history and events will be removed.`)) return;
		await api("DELETE", `/api/sessions/${encodeURIComponent(session.id)}`).catch((error) => alert(error.message));
	};
	if (!sessions.length) return html`<div class="small faint">No sessions have connected yet.</div>`;
	return html`<div class="table-wrap">
		<table class="table">
			<thead>
				<tr>
					<th></th>
					<th>Name</th>
					<th>Working directory</th>
					<th>Status</th>
					<th>Review</th>
					<th>Auto-approve edits</th>
					<th>Last seen</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				${sessions.map(
					(s) => html`<tr key=${s.id} class=${s.online ? "" : "offline-row"}>
						<td><span class=${`dot ${s.online ? "" : "dim"}`} style=${`--c:${colorOf(s)}`} title=${s.color?.name ?? ""}></span></td>
						<td><${RenameCell} session=${s} /></td>
						<td class="mono tiny ellipsis" style="max-width:280px" title=${s.cwd}>${s.cwd}</td>
						<td><${Status} value=${s.online ? s.status : "offline"} /></td>
						<td><${ReviewModeToggle} session=${s} showLabel=${false} /></td>
						<td><${Switch} on=${s.trust === "auto"} onChange=${(value) => setTrust(s, value)} label=${s.trust === "auto" ? "auto" : "review"} /></td>
						<td class="tiny faint">${s.online ? "online" : `${timeAgo(s.lastSeen)} ago`}</td>
						<td>
							<div class="row" style="justify-content:flex-end">
								<button class="btn sm ghost" onClick=${() => navigate(`#/agents/${encodeURIComponent(s.id)}`)}>Open</button>
								${s.online ? null : html`<button class="btn sm bad" onClick=${() => forget(s)}>Forget</button>`}
							</div>
						</td>
					</tr>`,
				)}
			</tbody>
		</table>
	</div>`;
}

export function SettingsView() {
	const state = useStore();
	useTick(30000);
	const [draft, setDraft] = useState(() => withDefaults(state.config));
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	useEffect(() => {
		if (!dirty) setDraft(withDefaults(state.config));
	}, [state.config]);

	const update = (mutate) => {
		setDraft((current) => {
			const next = structuredClone(current);
			mutate(next);
			return next;
		});
		setDirty(true);
		setMessage("");
	};

	const save = async () => {
		setBusy(true);
		try {
			const payload = structuredClone(draft);
			payload.review.autoApprove = cleanRules(payload.review.autoApprove);
			payload.review.contextLines = Number(payload.review.contextLines) || 0;
			payload.summaries.minTurns = Number(payload.summaries.minTurns) || 0;
			payload.prPollSeconds = Math.max(15, Number(payload.prPollSeconds) || 90);
			payload.piCommand = payload.piCommand?.trim() || "pi";
			const { config } = await api("PUT", "/api/config", { ...(state.config ?? {}), ...payload });
			state.config = config;
			setDraft(withDefaults(config));
			setDirty(false);
			setMessage("Saved ✓");
		} catch (error) {
			setMessage(error.message);
		} finally {
			setBusy(false);
		}
	};

	const reset = () => {
		setDraft(withDefaults(state.config));
		setDirty(false);
		setMessage("");
	};

	if (!state.config) return html`<div class="page"><${Empty} icon="⚙" title="Loading settings…" /></div>`;

	const n = draft.notifications;
	const rules = draft.review.autoApprove;
	const sessions = sorted(state.sessions, "lastSeen", true).sort((a, b) => Number(b.online) - Number(a.online));
	const hub = state.hub ?? {};

	return html`<div class="page">
		<div class="page-head">
			<div>
				<div class="page-title">Settings</div>
				<div class="page-sub">Hub configuration is stored in ${hub.dir ? html`<span class="mono">${hub.dir}</span>` : "the hub directory"}</div>
			</div>
			<span class="spacer"></span>
			${message ? html`<span class="small" style=${`color:${message.startsWith("Saved") ? "var(--ok)" : "var(--bad)"}`}>${message}</span>` : null}
			${dirty ? html`<button class="btn ghost" onClick=${reset}>Discard</button>` : null}
			<button class="btn primary" disabled=${!dirty || busy} onClick=${save}>${busy ? "Saving…" : "Save changes"}</button>
		</div>

		<div class="settings-grid">
			<${Section} title="Notifications" sub="Toasts, sounds and desktop alerts for inbox items">
				<${Switch} on=${n.enabled !== false} onChange=${(v) => update((d) => (d.notifications.enabled = v))} label="Notifications enabled" />
				<${Switch} on=${n.sound !== false} onChange=${(v) => update((d) => (d.notifications.sound = v))} label="Play sounds" />
				<div class="well settings-kinds">
					${NOTIFICATION_KINDS.map(
						(k) => html`<${Switch} on=${n.kinds[k.kind] !== false} onChange=${(v) => update((d) => (d.notifications.kinds[k.kind] = v))} label=${k.label} />`,
					)}
				</div>
				<${BrowserNotifications} />
			<//>

			<${Section} title="Review" sub="Edits matching a rule are approved without opening a diff review">
				<div class="col" style="gap:8px">
					${rules.map(
						(rule, index) => html`<div class="row rule-row">
							<input class="input mono" placeholder="glob, e.g. **/*.test.ts" value=${rule.glob} onInput=${(e) => update((d) => (d.review.autoApprove[index].glob = e.target.value))} />
							<select class="input" style="width:110px" value=${rule.tool ?? ""} onChange=${(e) => update((d) => (d.review.autoApprove[index].tool = e.target.value))}>
								<option value="">any tool</option>
								<option value="edit">edit</option>
								<option value="write">write</option>
							</select>
							<input class="input" style="width:150px" placeholder="any session" list="settings-session-names" value=${rule.session ?? ""} onInput=${(e) => update((d) => (d.review.autoApprove[index].session = e.target.value))} />
							<button class="btn sm icon ghost" title="Remove rule" onClick=${() => update((d) => d.review.autoApprove.splice(index, 1))}>✕</button>
						</div>`,
					)}
					${rules.length ? null : html`<div class="small faint">No auto-approve rules. Every edit waits for your review unless the session is trusted.</div>`}
					<datalist id="settings-session-names">${sessions.map((s) => html`<option value=${sessionName(s)} />`)}</datalist>
					<div><button class="btn sm" onClick=${() => update((d) => d.review.autoApprove.push({ glob: "", tool: "", session: "" }))}>Add rule</button></div>
				</div>
				<${NumberField} label="Diff context lines" value=${draft.review.contextLines} onChange=${(v) => update((d) => (d.review.contextLines = v))} />
				<${Switch} on=${draft.openBrowserOnReview !== false} onChange=${(v) => update((d) => (d.openBrowserOnReview = v))} label="Open the browser when a review arrives" />
			<//>

			<${Section} title="Summaries" sub="Ask agents to summarize their run when they finish">
				<${Switch} on=${draft.summaries.onAgentEnd !== false} onChange=${(v) => update((d) => (d.summaries.onAgentEnd = v))} label="Summarize on agent end" />
				<${NumberField} label="Minimum turns before summarizing" value=${draft.summaries.minTurns} min=${1} onChange=${(v) => update((d) => (d.summaries.minTurns = v))} />
			<//>

			<${Section} title="Integrations" sub="GitHub polling and agent spawning">
				<${NumberField} label="Pull request poll interval" value=${draft.prPollSeconds} min=${15} suffix="seconds" onChange=${(v) => update((d) => (d.prPollSeconds = v))} />
				<label class="row small" style="gap:10px">
					<span style="flex:1">pi command used to spawn agents</span>
					<input class="input mono" style="width:200px" value=${draft.piCommand} placeholder="pi" onInput=${(e) => update((d) => (d.piCommand = e.target.value))} />
				</label>
				<div class="row small">
					<span style="flex:1">GitHub CLI</span>
					<span class=${`pill ${hub.gh ? "ok" : "bad"}`}>${hub.gh ? "gh available" : "gh not found"}</span>
				</div>
			<//>
		</div>

		<div style="margin-top:18px">
			<${Section} title="Sessions" sub="Every agent the hub has seen. Trusted sessions skip diff review entirely.">
				<${SessionsTable} sessions=${sessions} />
			<//>
		</div>

		<div style="margin-top:18px">
			<${Section} title="Hub">
				<div class="stats">
					<div class="stat"><div class="stat-v">v${hub.version ?? "?"}</div><div class="stat-k">version</div></div>
					<${Stat} value=${hub.pid ?? "?"} label="pid" />
					<${Stat} value=${hub.platform ?? "?"} label="platform" />
					<${Stat} value=${state.connected ? "live" : "offline"} label="stream" />
				</div>
				<div class="well mono tiny" style="word-break:break-all">${hub.dir ?? ""}</div>
			<//>
		</div>
	</div>`;
}
