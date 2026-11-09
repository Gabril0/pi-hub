import { html, useState } from "../vendor/preact-htm.js";
import { api, sessionOf, sorted, useStore } from "../lib/store.js";
import { Stat, Empty, Markdown, SessionChip, colorOf, duration, money, navigate, sessionName, timeAgo, useTick } from "../lib/util.js";

function excerpt(text, max = 120) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function splitPath(path) {
	const value = String(path ?? "");
	const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	return index < 0 ? { dir: "", base: value } : { dir: value.slice(0, index + 1), base: value.slice(index + 1) };
}

function ResultRow({ result, active }) {
	const session = sessionOf(result.sessionId);
	return html`<div class=${`list-row ${active ? "active" : ""}`} style=${`--c:${colorOf(session)}`} onClick=${() => navigate(`#/results/${encodeURIComponent(result.id)}`)}>
		<div class="accent-bar"></div>
		<div class="col" style="gap:5px;min-width:0;flex:1">
			<div class="row" style="min-width:0">
				<span class="dot" style=${`--c:${colorOf(session)};width:8px;height:8px`}></span>
				<span class="small ellipsis" style="font-weight:700;color:var(--ink)">${session ? sessionName(session) : "unknown"}</span>
				<span class="spacer"></span>
				${result.error ? html`<span class="pill bad">error</span>` : null}
				<span class="tiny faint">${timeAgo(result.createdAt)}</span>
			</div>
			<div class="small ellipsis">${excerpt(result.prompt, 100) || html`<span class="faint">(no prompt)</span>`}</div>
			<div class="row tiny faint wrap">
				${result.durationMs != null ? html`<span>⏱ ${duration(result.durationMs)}</span>` : null}
				${result.turns != null ? html`<span>↻ ${result.turns} turns</span>` : null}
				${result.cost ? html`<span>${money(result.cost)}</span>` : null}
				${result.files?.length ? html`<span>✎ ${result.files.length} files</span>` : null}
			</div>
		</div>
	</div>`;
}

function ResultDetail({ result }) {
	const session = sessionOf(result.sessionId);
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		if (!confirm("Delete this result?")) return;
		setBusy(true);
		try {
			await api("POST", `/api/results/${encodeURIComponent(result.id)}/delete`);
			navigate("#/results");
		} catch (error) {
			alert(error.message);
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="col" style="gap:16px">
		<div class="card glossy" style=${`--c:${colorOf(session)};padding-left:22px`}>
			<div class="accent-bar"></div>
			<div class="row wrap">
				${session ? html`<${SessionChip} session=${session} onClick=${() => navigate(`#/agents/${encodeURIComponent(session.id)}`)} />` : html`<span class="pill">unknown session</span>`}
				${result.error ? html`<span class="pill bad">errored</span>` : html`<span class="pill ok">completed</span>`}
				<span class="tiny faint">${new Date(result.createdAt).toLocaleString()}</span>
				<span class="spacer"></span>
				<button class="btn sm bad" disabled=${busy} onClick=${remove}>Delete</button>
			</div>
			<div class="stats" style="margin-top:14px">
				<${Stat} value=${result.durationMs != null ? duration(result.durationMs) : "–"} label="duration" />
				<${Stat} value=${result.turns ?? "–"} label="turns" />
				<${Stat} value=${money(result.cost)} label="session cost" />
				<${Stat} value=${result.files?.length ?? 0} label="files" />
			</div>
		</div>
		${result.prompt
			? html`<div class="card">
					<div class="tiny faint" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:0.08em">Prompt</div>
					<div class="well small" style="white-space:pre-wrap;word-break:break-word">${result.prompt}</div>
				</div>`
			: null}
		${result.error
			? html`<div class="card">
					<div class="tiny" style="margin-bottom:6px;color:var(--bad);text-transform:uppercase;letter-spacing:0.08em">Error</div>
					<pre class="code-block">${result.error}</pre>
				</div>`
			: null}
		<div class="card">
			<div class="tiny faint" style="margin-bottom:8px;text-transform:uppercase;letter-spacing:0.08em">Result</div>
			${result.text ? html`<${Markdown} text=${result.text} />` : html`<div class="small faint">(empty)</div>`}
		</div>
		${result.files?.length
			? html`<div class="card">
					<div class="tiny faint" style="margin-bottom:8px;text-transform:uppercase;letter-spacing:0.08em">Files touched</div>
					<div class="col" style="gap:4px">
						${result.files.map((file) => {
							const { dir, base } = splitPath(file);
							return html`<div class="row small" title=${file} style="min-width:0">
								<span class="faint">✎</span>
								<span class="mono" style="color:var(--ink)">${base}</span>
								<span class="mono tiny faint ellipsis" style="flex:1">${dir}</span>
							</div>`;
						})}
					</div>
				</div>`
			: null}
	</div>`;
}

export function ResultsView({ id }) {
	const state = useStore();
	useTick(15000);
	const [query, setQuery] = useState("");
	const all = sorted(state.results, "createdAt", true);
	const needle = query.trim().toLowerCase();
	const visible = needle
		? all.filter((r) => [r.prompt, r.text, sessionName(sessionOf(r.sessionId))].some((v) => String(v ?? "").toLowerCase().includes(needle)))
		: all;
	const selected = (id && state.results.get(id)) || visible[0];

	return html`<div class="page">
		<div class="page-head">
			<div>
				<div class="page-title">Results</div>
				<div class="page-sub">${all.length} finished run${all.length === 1 ? "" : "s"} · ${all.filter((r) => r.error).length} errored</div>
			</div>
			<span class="spacer"></span>
			<input class="input" style="width:280px" placeholder="Search prompt, text, session…" value=${query} onInput=${(e) => setQuery(e.target.value)} />
		</div>
		${all.length
			? html`<div class="split list-first">
					<div class="card" style="padding:8px;min-width:0;align-self:start">
						<div class="col" style="gap:4px">
							${visible.map((r) => html`<${ResultRow} key=${r.id} result=${r} active=${selected?.id === r.id} />`)}
							${visible.length ? null : html`<div class="small faint" style="padding:12px">Nothing matches “${query}”.</div>`}
						</div>
					</div>
					<div style="min-width:0">${selected ? html`<${ResultDetail} key=${selected.id} result=${selected} />` : null}</div>
				</div>`
			: html`<${Empty} icon="★" title="No results yet">When an agent finishes a run, its final answer lands here.<//>`}
	</div>`;
}
