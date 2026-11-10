import { html, useState } from "../vendor/preact-htm.js";
import { Icon } from "../lib/icons.js";
import { api, sessionOf, sorted, useStore } from "../lib/store.js";
import { Empty, LineStats, Markdown, SessionChip, colorOf, navigate, timeAgo, useTick } from "../lib/util.js";

const KINDS = {
	review: { icon: "◧", label: "Review", color: "var(--warn)" },
	changeset: { icon: "◧", label: "Changes", color: "var(--warn)" },
	question: { icon: "?", label: "Question", color: "var(--warn)" },
	conflict: { icon: "⚠", label: "Conflict", color: "var(--warn)" },
	error: { icon: "!", label: "Error", color: "var(--bad)" },
	test_fail: { icon: "✗", label: "Tests", color: "var(--bad)" },
	message: { icon: "✉", label: "Message", color: "var(--accent-hi)" },
	pr: { icon: "⑂", label: "PR", color: "var(--accent-hi)" },
	done: { icon: "✓", label: "Done", color: "var(--ok)" },
};
const PRIORITY = { review: 0, changeset: 0, question: 0, conflict: 1, error: 1, test_fail: 2, message: 2, pr: 3, done: 4 };

function QuestionAnswer({ item }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const send = async (answer) => {
		if (!answer.trim()) return;
		setBusy(true);
		try {
			await api("POST", `/api/inbox/${item.id}/answer`, { text: answer });
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="col" style="margin-top:10px">
		${item.options?.length
			? html`<div class="row wrap">${item.options.map((o) => html`<button class="btn sm" disabled=${busy} onClick=${() => send(o)}>${o}</button>`)}</div>`
			: null}
		<div class="composer">
			<input
				class="input"
				placeholder="Type an answer…"
				value=${text}
				onInput=${(e) => setText(e.target.value)}
				onKeyDown=${(e) => e.key === "Enter" && send(text)}
			/>
			<button class="send-btn" title="Answer (Enter)" disabled=${busy || !text.trim()} onClick=${() => send(text)}><${Icon} name="send" size=${16} /></button>
		</div>
	</div>`;
}

function ReplyToAgent({ item }) {
	const [text, setText] = useState("");
	const [sent, setSent] = useState(false);
	const send = async () => {
		if (!text.trim()) return;
		await api("POST", `/api/sessions/${encodeURIComponent(item.sessionId)}/message`, { text, deliverAs: "followUp" });
		await api("POST", `/api/inbox/${item.id}/resolve`, { outcome: "replied" });
		setSent(true);
	};
	if (sent) return html`<div class="small muted" style="margin-top:8px">Reply sent ✓</div>`;
	return html`<div class="composer" style="margin-top:10px">
		<input class="input" placeholder="Reply to the agent…" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && send()} />
		<button class="send-btn" title="Reply (Enter)" disabled=${!text.trim()} onClick=${send}><${Icon} name="send" size=${16} /></button>
	</div>`;
}

function InboxItem({ item }) {
	const state = useStore();
	const review = item.kind === "review" || item.kind === "conflict" ? state.reviews.get(item.refId) : null;
	const changeset = item.kind === "changeset" ? state.changesets.get(item.refId) : null;
	const session = sessionOf(item.sessionId);
	const kind = KINDS[item.kind] ?? { icon: "•", label: item.kind, color: "var(--ink-soft)" };
	const open = () => item.path && navigate(item.path);
	const dismiss = (e) => {
		e.stopPropagation();
		api("POST", `/api/inbox/${item.id}/resolve`, {});
	};
	const actionable = ["review", "changeset", "conflict", "test_fail", "error", "done", "pr"].includes(item.kind) && item.path && item.path !== "#/inbox";
	const body = item.body && item.body.trim() !== item.title?.trim() && changeset?.kind !== "bash" ? item.body : "";
	return html`<div class=${`card inbox-item ${item.resolved ? "resolved" : ""}`} style=${`--c:${colorOf(session)}`}>
		<div class="accent-bar"></div>
		<div class="inbox-icon" style=${`color:${kind.color}`}><${Icon} name=${item.kind} size=${17} /></div>
		<div style="min-width:0">
			<div class="row wrap" style="gap:8px;margin-bottom:4px">
				${session ? html`<${SessionChip} session=${session} onClick=${() => navigate(`#/agents/${encodeURIComponent(session.id)}`)} />` : null}
				<span class="pill">${kind.label}</span>
				<span class="tiny faint">${timeAgo(item.createdAt)}</span>
				${item.resolved ? html`<span class="pill ok">${item.outcome ?? "resolved"}</span>` : null}
				${review?.step ? html`<span class="tiny faint ellipsis" style="max-width:260px" title="Active plan step">▸ ${review.step}</span>` : null}
			</div>
			<div class="row" style="gap:10px;align-items:baseline">
				<div class="inbox-title">${item.title}</div>
				${item.kind === "review" ? html`<${LineStats} stats=${review?.stats} />` : null}
			</div>
			${changeset?.title && changeset.kind === "bash" ? html`<code class="inbox-command">$ ${changeset.title}</code>` : null}
			${body ? html`<${Markdown} text=${body} class="inbox-body" />` : null}
			${item.answer ? html`<div class="small" style="margin-top:6px;color:var(--ok)">↳ ${item.answer}</div>` : null}
			${!item.resolved && item.kind === "question" ? html`<${QuestionAnswer} item=${item} />` : null}
			${!item.resolved && item.kind === "message" ? html`<${ReplyToAgent} item=${item} />` : null}
		</div>
		<div class="inbox-actions">
			${actionable ? html`<button class="btn sm primary" onClick=${open}>Open</button>` : null}
			${!item.resolved && !["review", "question", "changeset"].includes(item.kind) ? html`<button class="btn sm ghost" onClick=${dismiss}>Dismiss</button>` : null}
		</div>
	</div>`;
}

export function InboxView() {
	const state = useStore();
	useTick(20000);
	const [showResolved, setShowResolved] = useState(false);
	const [filter, setFilter] = useState(null);
	const all = sorted(state.inbox).filter((i) => !filter || i.sessionId === filter);
	const open = all.filter((i) => !i.resolved).sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || b.createdAt - a.createdAt);
	const resolved = all.filter((i) => i.resolved).slice(0, 60);
	const sessionIds = [...new Set(sorted(state.inbox).filter((i) => !i.resolved).map((i) => i.sessionId).filter(Boolean))];

	return html`<div class="page">
		<div class="page-head">
			<div>
				<h1 class="page-title">Inbox</h1>
				<div class="page-sub">${open.length ? `${open.length} thing${open.length > 1 ? "s" : ""} need you` : "All clear"}</div>
			</div>
			<div class="spacer"></div>
			<div class="row wrap">
				${sessionIds.map((id) => html`<${SessionChip} id=${id} on=${filter === id} onClick=${() => setFilter(filter === id ? null : id)} />`)}
			</div>
			<button class="btn sm" onClick=${() => api("POST", "/api/inbox/resolve-all", {})}>Clear notifications</button>
			<button class=${`btn sm ${showResolved ? "pressed" : ""}`} onClick=${() => setShowResolved(!showResolved)}>History</button>
		</div>
		<div class="col" style="gap:14px">
			${open.length ? open.map((item) => html`<${InboxItem} key=${item.id} item=${item} />`) : html`<${Empty} icon="✦" title="Nothing needs you right now">Reviews, questions, failing tests and finished runs land here.<//>`}
		</div>
		${showResolved && resolved.length
			? html`<h3 style="margin:28px 0 12px" class="muted">History</h3>
				<div class="col" style="gap:12px">${resolved.map((item) => html`<${InboxItem} key=${item.id} item=${item} />`)}</div>`
			: null}
	</div>`;
}
