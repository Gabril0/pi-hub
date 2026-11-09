import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, loadEvents, sessionOf, sorted, useStore } from "../lib/store.js";
import { Empty, Stat, Markdown, MonoBadge, SessionChip, Status, Switch, clock, colorOf, compact, duration, money, navigate, sessionName, timeAgo, useTick } from "../lib/util.js";
import { SessionChanges } from "./review.js";

const TL_ICONS = {
	agent_start: "▶",
	agent_end: "■",
	assistant: "💬",
	tool: "⚙",
	tool_error: "✗",
	review: "◧",
	progress: "☰",
	summary: "✦",
	test: "✓",
	question: "?",
	answer: "↳",
	message_in: "⇠",
	message_out: "⇢",
	error: "!",
};

function contextPercent(session) {
	const pct = session.context?.percent;
	return typeof pct === "number" ? Math.round(pct) : undefined;
}

export function Progress({ session, limit = 6 }) {
	const steps = session.progress?.steps ?? [];
	if (!steps.length) return null;
	const done = steps.filter((s) => s.status === "done").length;
	const marks = { done: "✓", active: "▸", blocked: "✗", pending: "○" };
	return html`<div class="col" style="gap:8px">
		<div class="row small"><span class="muted">Plan</span><span class="spacer"></span><span class="faint">${done}/${steps.length}</span></div>
		<div class="meter" style=${`--c:${colorOf(session)}`}><span style=${`width:${(done / steps.length) * 100}%`}></span></div>
		<div class="steps">
			${steps.slice(0, limit).map((s) => html`<div class=${`step ${s.status}`}><span class="mark">${marks[s.status] ?? "○"}</span><span>${s.title}</span></div>`)}
			${steps.length > limit ? html`<div class="tiny faint">+${steps.length - limit} more</div>` : null}
		</div>
		${session.progress?.note ? html`<div class="small muted">${session.progress.note}</div>` : null}
	</div>`;
}

function QuickMessage({ session }) {
	const [text, setText] = useState("");
	const [sent, setSent] = useState(false);
	const send = async () => {
		if (!text.trim()) return;
		await api("POST", `/api/sessions/${encodeURIComponent(session.id)}/message`, { text, deliverAs: "steer" });
		setText("");
		setSent(true);
		setTimeout(() => setSent(false), 1500);
	};
	return html`<div class="row">
		<input
			class="input"
			style="padding:8px 12px"
			placeholder=${session.online ? (sent ? "sent ✓" : `Message ${sessionName(session)}…`) : "offline"}
			disabled=${!session.online}
			value=${text}
			onInput=${(e) => setText(e.target.value)}
			onKeyDown=${(e) => e.key === "Enter" && send()}
			onClick=${(e) => e.stopPropagation()}
		/>
	</div>`;
}

function AgentCard({ session }) {
	const state = useStore();
	const reviews = [...state.reviews.values()].filter((r) => r.sessionId === session.id && (r.status === "pending" || r.status === "thinking"));
	const questions = [...state.inbox.values()].filter((i) => i.sessionId === session.id && i.kind === "question" && !i.resolved);
	const pct = contextPercent(session);
	const elapsed = session.status === "working" && session.runStartedAt ? Date.now() - session.runStartedAt : undefined;
	return html`<div class="card glossy agent-card" style=${`--c:${colorOf(session)}`}>
		<div class="accent-bar"></div>
		<div class="row">
			<${MonoBadge} session=${session} large=${true} />
			<a class="agent-name" style="color:var(--ink)" href=${`#/agents/${encodeURIComponent(session.id)}`}>${sessionName(session)}</a>
			<span class="spacer"></span>
			<${Status} value=${session.online ? session.status : "offline"} />
		</div>
		<div class="agent-meta">
			${session.repo ? html`<span>⌂ ${session.repo}${session.branch ? html` <span class="faint">@${session.branch}</span>` : null}</span>` : null}
			${session.model ? html`<span class="ellipsis" style="max-width:180px">◆ ${session.model.split("/").pop()}</span>` : null}
			${session.tmuxPane ? html`<span title="tmux pane">▣ pane ${session.tmuxPane}</span>` : null}
			${session.trust === "auto" ? html`<span class="pill warn">auto-approve</span>` : null}
		</div>
		${reviews.length || questions.length
			? html`<div class="row wrap agent-pills">
					${reviews.map((r) => html`<a class="pill warn" title=${`Review ${r.path}`} href=${`#/review/${r.id}`}>◧ ${r.path.split("/").pop()}</a>`)}
					${questions.map((q) => html`<a class="pill accent" title=${q.title} href="#/inbox">? ${q.title}</a>`)}
				</div>`
			: null}
		${session.currentPrompt ? html`<div class="agent-task">${session.currentPrompt}</div>` : html`<div class="agent-task faint">No task yet</div>`}
		<${Progress} session=${session} limit=${4} />
		${session.summary?.text
			? html`<div class="well small"><${Markdown} text=${session.summary.text} /></div>`
			: session.lastMessage
				? html`<div class="well small muted last-message"><${Markdown} text=${session.lastMessage} /></div>`
				: null}
		${session.lastTool && session.status === "working" ? html`<div class="tiny faint ellipsis">⚙ ${session.lastTool.name} ${session.lastTool.summary} · ${timeAgo(session.lastTool.at)}</div>` : null}
		<div class="stats">
			<${Stat} value=${money(session.usage?.cost)} label="cost" />
			<${Stat} value=${compact((session.usage?.input ?? 0) + (session.usage?.output ?? 0) + (session.usage?.cacheRead ?? 0))} label="tokens" />
			<${Stat} value=${pct !== undefined ? `${pct}%` : "–"} label="context" />
			<${Stat}
				value=${elapsed ? duration(elapsed) : session.lastTest ? (session.lastTest.status === "passed" ? "pass" : "fail") : "–"}
				label=${elapsed ? "running" : "tests"}
				tone=${!elapsed && session.lastTest ? (session.lastTest.status === "passed" ? "ok" : "bad") : undefined}
			/>
		</div>
		<${QuickMessage} session=${session} />
		<div class="row">
			<button class="btn sm" onClick=${() => navigate(`#/agents/${encodeURIComponent(session.id)}`)}>Details</button>
			<button class="btn sm" disabled=${!session.online} onClick=${() => api("POST", `/api/sessions/${encodeURIComponent(session.id)}/focus`)} title="Focus the terminal pane">⤢ Jump</button>
			<span class="spacer"></span>
			${session.status === "working" ? html`<button class="btn sm bad" onClick=${() => api("POST", `/api/sessions/${encodeURIComponent(session.id)}/abort`)}>■ Stop</button>` : null}
		</div>
	</div>`;
}

export function AgentsView() {
	const state = useStore();
	useTick(5000);
	const [showOffline, setShowOffline] = useState(false);
	const sessions = sorted(state.sessions, "createdAt", false);
	const online = sessions.filter((s) => s.online);
	const offline = sessions.filter((s) => !s.online);
	const totalCost = sessions.reduce((sum, s) => sum + (s.usage?.cost ?? 0), 0);
	const working = online.filter((s) => s.status === "working").length;
	const waiting = online.filter((s) => s.status === "waiting").length;
	return html`<div class="page">
		<div class="page-head">
			<div>
				<h1 class="page-title">Agents</h1>
				<div class="page-sub">${online.length} online · ${working} working · ${waiting} waiting on you · ${money(totalCost)} total</div>
			</div>
			<div class="spacer"></div>
			<button class=${`btn sm ${showOffline ? "pressed" : ""}`} onClick=${() => setShowOffline(!showOffline)}>Offline (${offline.length})</button>
		</div>
		${online.length
			? html`<div class="grid cards">${online.map((s) => html`<${AgentCard} key=${s.id} session=${s} />`)}</div>`
			: html`<${Empty} icon="◉" title="No agents connected">Start <code>pi</code> with the pi-hub extension installed, or spawn one with “New agent”.<//>`}
		${showOffline && offline.length
			? html`<h3 class="muted" style="margin:28px 0 12px">Offline</h3>
				<div class="grid cards">${offline.map((s) => html`<${AgentCard} key=${s.id} session=${s} />`)}</div>`
			: null}
	</div>`;
}

function TimelineIcon({ event }) {
	if (event.kind !== "test") return html`<span>${TL_ICONS[event.kind] ?? "•"}</span>`;
	const failed = /failed|error/i.test(String(event.text ?? "").replace(/\b0 (?:failed|errors?)\b/gi, ""));
	return html`<span style=${`color:${failed ? "var(--bad)" : "var(--ok)"}`}>${failed ? "✗" : "✓"}</span>`;
}

function Timeline({ sessionId }) {
	const state = useStore();
	const [filter, setFilter] = useState("all");
	useEffect(() => {
		loadEvents(sessionId);
	}, [sessionId]);
	const events = state.events.get(sessionId) ?? [];
	const groups = { all: null, talk: ["agent_start", "agent_end", "assistant", "message_in", "message_out", "question", "answer", "summary"], tools: ["tool", "tool_error", "review", "test"] };
	const shown = events.filter((e) => !groups[filter] || groups[filter].includes(e.kind)).slice(-300).reverse();
	return html`<div class="card">
		<div class="row" style="margin-bottom:10px">
			<h3>Timeline</h3>
			<span class="spacer"></span>
			<div class="segmented">
				${Object.keys(groups).map((g) => html`<button class=${filter === g ? "on" : ""} onClick=${() => setFilter(g)}>${g}</button>`)}
			</div>
		</div>
		<div class="timeline" style="max-height:620px;overflow:auto">
			${shown.length
				? shown.map(
						(e) => html`<div class=${`tl-item ${e.kind}`}>
							<span class="tl-time">${clock(e.at)}</span>
							<${TimelineIcon} event=${e} />
							<span class="tl-text">
								${e.toolName ? html`<b style="color:var(--ink)">${e.toolName}</b> ` : null}${e.text}
								${e.reviewId ? html` <a href=${`#/review/${e.reviewId}`}>open</a>` : null}
								${e.testRunId ? html` <a href=${`#/tests/${e.testRunId}`}>open</a>` : null}
							</span>
						</div>`,
					)
				: html`<div class="small faint">No events yet.</div>`}
		</div>
	</div>`;
}

function Controls({ session }) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState("steer");
	const [renaming, setRenaming] = useState(false);
	const [name, setName] = useState(sessionName(session));
	const [note, setNote] = useState("");
	const id = encodeURIComponent(session.id);
	const send = async () => {
		if (!text.trim()) return;
		const { delivered } = await api("POST", `/api/sessions/${id}/message`, { text, deliverAs: mode });
		setText("");
		setNote(delivered ? "Delivered ✓" : "Agent offline — not delivered");
		setTimeout(() => setNote(""), 2500);
	};
	return html`<div class="card glossy col" style="gap:12px">
		<div class="row">
			<h3>Talk to ${sessionName(session)}</h3>
			<span class="spacer"></span>
			<div class="segmented">
				<button class=${mode === "steer" ? "on" : ""} onClick=${() => setMode("steer")} title="Delivered after the current tool calls">steer</button>
				<button class=${mode === "followUp" ? "on" : ""} onClick=${() => setMode("followUp")} title="Delivered when the agent finishes">follow-up</button>
			</div>
		</div>
		<textarea
			class="input"
			rows="3"
			placeholder="Message the agent (Ctrl+Enter to send)…"
			value=${text}
			onInput=${(e) => setText(e.target.value)}
			onKeyDown=${(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && send()}
		></textarea>
		<div class="row wrap">
			<button class="btn primary" disabled=${!session.online || !text.trim()} onClick=${send}>Send</button>
			<span class="small muted">${note}</span>
			<span class="spacer"></span>
			<button class="btn sm" disabled=${!session.online} onClick=${() => api("POST", `/api/sessions/${id}/focus`)}>⤢ Jump to pane</button>
			<button class="btn sm" disabled=${!session.online} onClick=${() => api("POST", `/api/sessions/${id}/summarize`)}>✦ Summarize</button>
			<button class="btn sm bad" disabled=${!session.online || session.status !== "working"} onClick=${() => api("POST", `/api/sessions/${id}/abort`)}>■ Stop</button>
		</div>
		<div class="row wrap" style="gap:16px">
			<${Switch} on=${session.trust === "auto"} label="Auto-approve this agent's changes" onChange=${(on) => api("POST", `/api/sessions/${id}/trust`, { mode: on ? "auto" : "review" })} />
			<span class="spacer"></span>
			${renaming
				? html`<div class="row">
						<input class="input" style="width:180px;padding:6px 10px" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && (api("POST", `/api/sessions/${id}/rename`, { name }), setRenaming(false))} />
						<button class="btn sm" onClick=${() => (api("POST", `/api/sessions/${id}/rename`, { name }), setRenaming(false))}>Save</button>
					</div>`
				: html`<button class="btn sm ghost" onClick=${() => setRenaming(true)}>✎ Rename</button>`}
		</div>
	</div>`;
}

export function AgentDetail({ id }) {
	const state = useStore();
	useTick(5000);
	const session = sessionOf(id);
	if (!session) return html`<div class="page"><${Empty} title="Unknown agent">It may have been forgotten.<//></div>`;
	const reviews = sorted(state.reviews).filter((r) => r.sessionId === id).slice(0, 12);
	const tests = sorted(state.testRuns).filter((r) => r.sessionId === id).slice(0, 6);
	const results = sorted(state.results).filter((r) => r.sessionId === id).slice(0, 5);
	const pct = contextPercent(session);
	return html`<div class="page" style=${`--c:${colorOf(session)}`}>
		<div class="page-head">
			<button class="btn sm ghost" onClick=${() => navigate("#/agents")}>← Agents</button>
			<${MonoBadge} session=${session} large=${true} />
			<div>
				<h1 class="page-title">${sessionName(session)}</h1>
				<div class="page-sub mono">${session.cwd}${session.branch ? ` @ ${session.branch}` : ""}</div>
			</div>
			<${Status} value=${session.online ? session.status : "offline"} />
			<span class="spacer"></span>
			<div class="stats" style="min-width:420px">
				<${Stat} value=${money(session.usage?.cost)} label="cost" />
				<${Stat} value=${session.turns ?? 0} label="turns" />
				<${Stat} value=${pct !== undefined ? `${pct}%` : "–"} label="context" />
				<${Stat} value=${(session.filesTouched ?? []).length} label="files" />
			</div>
		</div>
		<div class="split" style="grid-template-columns:minmax(0,1fr) 420px">
			<div class="col" style="gap:18px;min-width:0">
				${session.currentPrompt ? html`<div class="card"><div class="small faint" style="margin-bottom:6px">Current task</div><div>${session.currentPrompt}</div></div>` : null}
				<${SessionChanges} sessionId=${id} />
				<${Timeline} sessionId=${id} />
			</div>
			<div class="col" style="gap:18px">
				<${Controls} session=${session} />
				${session.summary?.text
					? html`<div class="card"><div class="row small faint" style="margin-bottom:6px">✦ Summary <span class="spacer"></span>${timeAgo(session.summary.at)}</div><${Markdown} text=${session.summary.text} /></div>`
					: null}
				${session.progress?.steps?.length ? html`<div class="card"><${Progress} session=${session} limit=${30} /></div>` : null}
				<div class="card">
					<h3 style="margin-bottom:10px">Reviews</h3>
					${reviews.length
						? reviews.map(
								(r) => html`<a class="list-row" href=${`#/review/${r.id}`}>
									<span class="ellipsis small" style="flex:1">${r.path}</span>
									${r.auto ? html`<span class="pill">auto</span>` : null}
									<${Status} value=${r.status} />
									<span class="tiny faint">${timeAgo(r.createdAt)}</span>
								</a>`,
							)
						: html`<div class="small faint">No reviews yet.</div>`}
				</div>
				<div class="card">
					<div class="row" style="margin-bottom:10px">
						<h3>Tests</h3>
						<span class="spacer"></span>
						<button class="btn sm" onClick=${async () => {
							const { id: runId } = await api("POST", "/api/tests/run", { sessionId: id });
							navigate(`#/tests/${runId}`);
						}}>▶ Run tests</button>
					</div>
					${tests.length
						? tests.map(
								(t) => html`<a class="list-row" href=${`#/tests/${t.id}`}>
									<span class="mono ellipsis" style="flex:1">${t.command}</span>
									<span class="tiny"><span style="color:var(--ok)">${t.summary?.passed ?? 0}✓</span> <span style="color:var(--bad)">${t.summary?.failed ?? 0}✗</span></span>
									<${Status} value=${t.status} />
								</a>`,
							)
						: html`<div class="small faint">No test runs yet.</div>`}
				</div>
				${results.length
					? html`<div class="card">
							<h3 style="margin-bottom:10px">Results</h3>
							${results.map(
								(r) => html`<a class="list-row" href=${`#/results/${r.id}`}>
									<span class="ellipsis small" style="flex:1">${r.prompt || r.text}</span>
									<span class="tiny faint">${timeAgo(r.createdAt)}</span>
								</a>`,
							)}
						</div>`
					: null}
			</div>
		</div>
	</div>`;
}

export function SpawnDialog({ onClose }) {
	const state = useStore();
	const recent = [...new Set(sorted(state.sessions, "lastSeen").map((s) => s.cwd).filter(Boolean))].slice(0, 8);
	const [cwd, setCwd] = useState(recent[0] ?? "");
	const [prompt, setPrompt] = useState("");
	const [name, setName] = useState("");
	const [result, setResult] = useState(null);
	const [busy, setBusy] = useState(false);
	const spawn = async () => {
		setBusy(true);
		try {
			const res = await api("POST", "/api/spawn", { cwd, prompt, name });
			setResult(res.ok ? `Launched via ${res.via}. It will appear here once pi connects.` : `Launch failed (${res.via}).`);
			if (res.ok) setTimeout(onClose, 1600);
		} catch (error) {
			setResult(error.message);
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="col" style="gap:14px">
		<h2>New agent</h2>
		<label class="field">Working directory
			<input class="input mono" value=${cwd} onInput=${(e) => setCwd(e.target.value)} placeholder="/absolute/path/to/repo" list="recent-cwds" />
			<datalist id="recent-cwds">${recent.map((c) => html`<option value=${c} />`)}</datalist>
		</label>
		<label class="field">Window name (optional)<input class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. listener-fix" /></label>
		<label class="field">First prompt (optional)<textarea class="input" rows="4" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder="What should this agent do?"></textarea></label>
		<div class="small muted">Opens a new tmux window when tmux is running, otherwise a new terminal window (Ghostty / Windows Terminal / your Linux terminal).</div>
		${result ? html`<div class="well small">${result}</div>` : null}
		<div class="row"><span class="spacer"></span><button class="btn ghost" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy || !cwd.trim()} onClick=${spawn}>Launch</button></div>
	</div>`;
}

export function BroadcastDialog({ onClose }) {
	const state = useStore();
	const [text, setText] = useState("");
	const [mode, setMode] = useState("followUp");
	const online = [...state.sessions.values()].filter((s) => s.online);
	const send = async () => {
		await api("POST", "/api/broadcast", { text, deliverAs: mode });
		onClose();
	};
	return html`<div class="col" style="gap:14px">
		<h2>Broadcast</h2>
		<div class="row wrap">${online.map((s) => html`<${SessionChip} session=${s} static=${true} />`)}</div>
		<textarea class="input" rows="4" value=${text} onInput=${(e) => setText(e.target.value)} placeholder="Message every online agent…"></textarea>
		<div class="row">
			<div class="segmented">
				<button class=${mode === "steer" ? "on" : ""} onClick=${() => setMode("steer")}>steer</button>
				<button class=${mode === "followUp" ? "on" : ""} onClick=${() => setMode("followUp")}>follow-up</button>
			</div>
			<span class="spacer"></span>
			<button class="btn ghost" onClick=${onClose}>Cancel</button>
			<button class="btn primary" disabled=${!text.trim() || !online.length} onClick=${send}>Send to ${online.length}</button>
		</div>
	</div>`;
}
