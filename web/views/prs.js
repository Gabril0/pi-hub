import { html, useState } from "../vendor/preact-htm.js";
import { api, useStore } from "../lib/store.js";
import { Empty, SessionChip, colorOf, navigate, timeAgo, useTick } from "../lib/util.js";

const STATE_TONE = { OPEN: "ok", MERGED: "accent", CLOSED: "bad" };
const CHECK_TONE = { passed: "ok", failed: "bad", pending: "warn", none: "" };
const CHECK_ICON = { passed: "✓", failed: "✗", pending: "◌" };
const REVIEW_TONE = { APPROVED: "ok", CHANGES_REQUESTED: "bad", REVIEW_REQUIRED: "warn" };
const MERGEABLE_TONE = { MERGEABLE: "ok", CONFLICTING: "bad", UNKNOWN: "" };

function label(value) {
	return String(value ?? "").toLowerCase().replace(/_/g, " ");
}

function PrCard({ pr }) {
	const [open, setOpen] = useState(pr.checksState === "failed");
	const checks = pr.checks ?? [];
	const failedFirst = [...checks].sort((a, b) => ({ failed: 0, pending: 1, passed: 2 })[a.state] - ({ failed: 0, pending: 1, passed: 2 })[b.state]);
	const passedCount = checks.filter((c) => c.state === "passed").length;
	const ids = pr.sessionIds?.length ? pr.sessionIds : pr.sessionId ? [pr.sessionId] : [];
	return html`<div class="card glossy pr-card" style=${`--c:${colorOf(ids[0])}`}>
		<div class="accent-bar"></div>
		<div class="row tiny muted">
			<span class="mono ellipsis">${pr.repo}</span>
			<span class="faint">#${pr.number}</span>
			<span class="spacer"></span>
			<span class=${`pill ${STATE_TONE[pr.state] ?? ""}`}>${label(pr.state)}</span>
			${pr.isDraft ? html`<span class="pill">draft</span>` : null}
		</div>
		<a class="pr-title" href=${pr.url} target="_blank" rel="noreferrer">${pr.title}</a>
		<div class="row small muted wrap">
			<span class="mono tiny branch">${pr.head}</span>
			<span class="faint">→</span>
			<span class="mono tiny branch">${pr.base}</span>
		</div>
		<div class="row wrap">
			${pr.reviewDecision && pr.reviewDecision !== "NONE" ? html`<span class=${`pill ${REVIEW_TONE[pr.reviewDecision] ?? ""}`}>review: ${label(pr.reviewDecision)}</span>` : html`<span class="pill">no review</span>`}
			${pr.mergeable ? html`<span class=${`pill ${MERGEABLE_TONE[pr.mergeable] ?? ""}`}>${label(pr.mergeable)}</span>` : null}
			<button class=${`pill pill-btn ${CHECK_TONE[pr.checksState] ?? ""}`} disabled=${!checks.length} onClick=${() => setOpen(!open)}>
				${CHECK_ICON[pr.checksState] ?? "·"} checks ${checks.length ? `${passedCount}/${checks.length}` : "none"} ${checks.length ? (open ? "▾" : "▸") : ""}
			</button>
		</div>
		${open && checks.length
			? html`<div class="well col" style="gap:4px;padding:8px 12px">
					${failedFirst.map(
						(check) => html`<div class="row small">
							<span class=${`check-mark ${check.state}`}>${CHECK_ICON[check.state] ?? "·"}</span>
							<span class="ellipsis" style="flex:1">${check.name}</span>
							${check.url ? html`<a class="tiny" href=${check.url} target="_blank" rel="noreferrer">details ↗</a>` : null}
						</div>`,
					)}
				</div>`
			: null}
		<div class="row wrap">
			${ids.map((id) => html`<${SessionChip} id=${id} onClick=${() => navigate(`#/agents/${encodeURIComponent(id)}`)} />`)}
			<span class="spacer"></span>
			<span class="tiny faint">${pr.mergedAt ? `merged ${timeAgo(Date.parse(pr.mergedAt))} ago · ` : ""}polled ${timeAgo(pr.lastPolled ?? pr.updatedAt)}</span>
		</div>
	</div>`;
}

export function PrsView() {
	const state = useStore();
	useTick(15000);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const order = { OPEN: 0, MERGED: 1, CLOSED: 2 };
	const prs = [...state.prs.values()].sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3) || (Date.parse(b.ghUpdatedAt ?? "") || b.updatedAt || 0) - (Date.parse(a.ghUpdatedAt ?? "") || a.updatedAt || 0));
	const open = prs.filter((p) => p.state === "OPEN");
	const failing = open.filter((p) => p.checksState === "failed").length;

	const refresh = async () => {
		setBusy(true);
		setError("");
		try {
			await api("POST", "/api/prs/refresh");
		} catch (e) {
			setError(e.message);
		} finally {
			setBusy(false);
		}
	};

	return html`<div class="page">
		<div class="page-head">
			<div>
				<div class="page-title">Pull requests</div>
				<div class="page-sub">${open.length} open · ${failing} with failing checks${state.config?.prPollSeconds ? ` · polls every ${state.config.prPollSeconds}s` : ""}</div>
			</div>
			<span class="spacer"></span>
			${error ? html`<span class="small" style="color:var(--bad)">${error}</span>` : null}
			<button class="btn" disabled=${busy || state.hub?.gh === false} onClick=${refresh}>${busy ? "Refreshing…" : "↻ Refresh"}</button>
		</div>
		${state.hub?.gh === false
			? html`<${Empty} icon="⑂" title="GitHub CLI not found">Install <code>gh</code> and run <code>gh auth login</code> so the hub can track pull requests for your agents' branches.<//>`
			: prs.length
				? html`<div class="grid cards">${prs.map((pr) => html`<${PrCard} key=${pr.id} pr=${pr} />`)}</div>`
				: html`<${Empty} icon="⑂" title="No pull requests yet">PRs for branches your online agents are working on show up here automatically.<//>`}
	</div>`;
}
