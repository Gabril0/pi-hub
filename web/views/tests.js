import { html, useEffect, useMemo, useState } from "../vendor/preact-htm.js";
import { api, sessionOf, sorted, useStore } from "../lib/store.js";
import { Stat, Empty, Modal, SessionChip, Status, colorOf, duration, navigate, sessionName, timeAgo, useTick } from "../lib/util.js";

const SEPARATORS = ["::", " › ", "/"];

function splitTestName(name) {
	let cut = -1;
	let width = 0;
	for (const sep of SEPARATORS) {
		const index = name.lastIndexOf(sep);
		if (index > cut) {
			cut = index;
			width = sep.length;
		}
	}
	if (cut < 0) {
		cut = name.lastIndexOf(".");
		width = 1;
	}
	if (cut <= 0) return { group: "(root)", leaf: name };
	return { group: name.slice(0, cut), leaf: name.slice(cut + width) };
}

function buildTree(tests) {
	const groups = new Map();
	for (const test of tests ?? []) {
		const { group, leaf } = splitTestName(test.name);
		if (!groups.has(group)) groups.set(group, { name: group, tests: [], failed: 0, passed: 0, skipped: 0 });
		const entry = groups.get(group);
		entry.tests.push({ ...test, leaf });
		entry[test.status] = (entry[test.status] ?? 0) + 1;
	}
	const rank = { failed: 0, skipped: 1, passed: 2 };
	const list = [...groups.values()];
	for (const group of list) group.tests.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.leaf.localeCompare(b.leaf));
	return list.sort((a, b) => (b.failed > 0) - (a.failed > 0) || b.failed - a.failed || a.name.localeCompare(b.name));
}

function statusTone(status) {
	if (status === "passed") return "ok";
	if (status === "running") return "warn";
	return "bad";
}

function Counts({ summary }) {
	if (!summary) return null;
	return html`<span class="row tiny" style="gap:6px">
		<span class="pill ok">${summary.passed ?? 0} ✓</span>
		${summary.failed ? html`<span class="pill bad">${summary.failed} ✗</span>` : null}
		${summary.skipped ? html`<span class="pill">${summary.skipped} ↷</span>` : null}
	</span>`;
}

function RunRow({ run, active }) {
	const session = sessionOf(run.sessionId);
	return html`<div class=${`list-row test-run-row ${active ? "active" : ""}`} style=${`--c:${colorOf(session)}`} onClick=${() => navigate(`#/tests/${encodeURIComponent(run.id)}`)}>
		<div class="accent-bar"></div>
		<div class="col" style="gap:4px;min-width:0;flex:1">
			<div class="row" style="min-width:0">
				<span class="mono ellipsis" style="flex:1;color:var(--ink)">${run.command}</span>
				<span class=${`pill ${statusTone(run.status)}`}>${run.status}</span>
			</div>
			<div class="row tiny faint wrap">
				<span class="dot" style=${`--c:${colorOf(session)};width:8px;height:8px`}></span>
				<span>${session ? sessionName(session) : "hub"}</span>
				<span>·</span>
				<span>${run.source ?? "agent"}</span>
				${run.durationMs != null ? html`<span>· ${duration(run.durationMs)}</span>` : null}
				<span>· ${timeAgo(run.createdAt)}</span>
				<span class="spacer"></span>
				<${Counts} summary=${run.summary} />
			</div>
			${run.status === "running" && run.outputTail ? html`<pre class="code-block tail-live">${run.outputTail.split("\n").slice(-4).join("\n")}</pre>` : null}
		</div>
	</div>`;
}

function TrendChart({ runs, currentId }) {
	const width = 300;
	const height = 70;
	const gap = 2;
	if (runs.length < 2) return html`<div class="tiny faint">Not enough history for a trend yet.</div>`;
	const max = Math.max(1, ...runs.map((r) => (r.summary?.passed ?? 0) + (r.summary?.failed ?? 0)));
	const slot = width / 15;
	const barWidth = Math.max(4, slot - gap * 2);
	return html`<div class="col" style="gap:6px">
		<svg class="trend-chart" viewBox=${`0 0 ${width} ${height + 4}`} role="img" aria-label="Pass and fail counts for recent runs">
			<line x1="0" x2=${width} y1=${height + 0.5} y2=${height + 0.5} stroke="var(--line-strong)" stroke-width="1" />
			${runs.map((run, index) => {
				const passed = run.summary?.passed ?? 0;
				const failed = run.summary?.failed ?? 0;
				const passHeight = (passed / max) * (height - 4);
				const failHeight = (failed / max) * (height - 4);
				const x = index * slot + gap;
				const failY = height - passHeight - failHeight - (passHeight && failHeight ? gap : 0);
				return html`<g class=${`trend-bar ${run.id === currentId ? "current" : ""}`} onClick=${() => navigate(`#/tests/${encodeURIComponent(run.id)}`)}>
					<title>${`${new Date(run.createdAt).toLocaleString()} · ${passed} passed · ${failed} failed · ${run.status}`}</title>
					<rect x=${x - gap} y="0" width=${slot} height=${height} fill="transparent" />
					${passHeight ? html`<rect x=${x} y=${height - passHeight} width=${barWidth} height=${passHeight} rx="2" fill="var(--ok)" />` : null}
					${failHeight ? html`<rect x=${x} y=${failY} width=${barWidth} height=${failHeight} rx="2" fill="var(--bad)" />` : null}
					${!passHeight && !failHeight ? html`<rect x=${x} y=${height - 2} width=${barWidth} height="2" rx="1" fill="var(--ink-faint)" />` : null}
					${run.id === currentId ? html`<rect x=${x} y=${height + 2} width=${barWidth} height="2" rx="1" fill="var(--accent)" />` : null}
				</g>`;
			})}
		</svg>
		<div class="row tiny muted">
			<span class="row" style="gap:5px"><span class="legend-swatch" style="background:var(--ok)"></span>passed</span>
			<span class="row" style="gap:5px"><span class="legend-swatch" style="background:var(--bad)"></span>failed</span>
			<span class="spacer"></span>
			<span class="faint">last ${runs.length} runs · max ${max}</span>
		</div>
	</div>`;
}

function TestGroup({ group }) {
	const [open, setOpen] = useState(group.failed > 0);
	const [expanded, setExpanded] = useState(() => new Set());
	const toggle = (name) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	return html`<div class="test-group">
		<div class="test-group-head" onClick=${() => setOpen(!open)}>
			<span class="faint">${open ? "▾" : "▸"}</span>
			<span class="mono ellipsis" style="flex:1">${group.name}</span>
			${group.failed ? html`<span class="pill bad">${group.failed} ✗</span>` : null}
			${group.passed ? html`<span class="pill ok">${group.passed} ✓</span>` : null}
			${group.skipped ? html`<span class="pill">${group.skipped} ↷</span>` : null}
		</div>
		${open
			? html`<div class="test-group-body">
					${group.tests.map((test) => {
						const canExpand = test.status === "failed" && test.output;
						const isOpen = expanded.has(test.name);
						return html`<div class=${`test-leaf ${test.status}`}>
							<div class="row" style=${canExpand ? "cursor:pointer" : ""} onClick=${() => canExpand && toggle(test.name)}>
								<span class=${`test-mark ${test.status}`}>${test.status === "passed" ? "✓" : test.status === "failed" ? "✗" : "↷"}</span>
								<span class="small ellipsis" style="flex:1" title=${test.name}>${test.leaf}</span>
								${test.durationMs != null ? html`<span class="tiny faint">${duration(test.durationMs)}</span>` : null}
								${canExpand ? html`<span class="tiny faint">${isOpen ? "hide" : "output"}</span>` : null}
							</div>
							${canExpand && isOpen ? html`<pre class="code-block">${test.output}</pre>` : null}
						</div>`;
					})}
				</div>`
			: null}
	</div>`;
}

function NameList({ title, names, tone, empty }) {
	return html`<div class="well col" style="gap:6px;min-width:0">
		<div class="row small"><span class=${`pill ${tone}`}>${names?.length ?? 0}</span><span class="muted">${title}</span></div>
		${names?.length
			? names.slice(0, 30).map((name) => html`<div class="mono tiny ellipsis" title=${name}>${name}</div>`)
			: html`<div class="tiny faint">${empty}</div>`}
	</div>`;
}

function RunDetail({ run, history }) {
	const [showRaw, setShowRaw] = useState(run.status === "running");
	const [busy, setBusy] = useState(false);
	const tree = useMemo(() => buildTree(run.tests), [run.tests]);
	const session = sessionOf(run.sessionId);
	const rerun = async () => {
		setBusy(true);
		try {
			const result = await api("POST", "/api/tests/run", { sessionId: run.sessionId, cwd: run.cwd, command: run.command });
			navigate(`#/tests/${encodeURIComponent(result.id)}`);
		} catch (error) {
			alert(error.message);
		} finally {
			setBusy(false);
		}
	};
	const stop = () => api("POST", `/api/tests/${encodeURIComponent(run.id)}/stop`).catch((error) => alert(error.message));
	const summary = run.summary ?? {};
	return html`<div class="col" style="gap:16px">
		<div class="card glossy" style=${`--c:${colorOf(session)};padding-left:22px`}>
			<div class="accent-bar"></div>
			<div class="row wrap">
				<span class="mono" style="font-size:14px;color:var(--ink)">${run.command}</span>
				<${Status} value=${run.status} />
				<span class="spacer"></span>
				${run.status === "running"
					? html`<button class="btn sm bad" onClick=${stop}>■ Stop</button>`
					: html`<button class="btn sm primary" disabled=${busy} onClick=${rerun}>↻ Re-run</button>`}
			</div>
			<div class="row wrap small muted" style="margin-top:8px">
				${session ? html`<${SessionChip} session=${session} onClick=${() => navigate(`#/agents/${encodeURIComponent(session.id)}`)} />` : html`<span class="pill">hub</span>`}
				<span class="mono tiny ellipsis" title=${run.cwd}>${run.cwd}</span>
				${run.framework ? html`<span class="pill accent">${run.framework}</span>` : null}
				<span class="pill">${run.source ?? "agent"}</span>
				${run.exitCode != null ? html`<span class="pill">exit ${run.exitCode}</span>` : null}
				<span class="tiny faint">${new Date(run.createdAt).toLocaleString()}</span>
			</div>
			<div class="stats" style="margin-top:14px">
				<${Stat} value=${summary.passed ?? 0} label="passed" tone="ok" />
				<${Stat} value=${summary.failed ?? 0} label="failed" tone="bad" />
				<${Stat} value=${summary.skipped ?? 0} label="skipped" />
				<${Stat} value=${summary.total ?? 0} label="total" />
				<${Stat} value=${run.durationMs != null ? duration(run.durationMs) : run.status === "running" ? duration(Date.now() - (run.startedAt ?? run.createdAt)) : "–"} label="duration" />
			</div>
		</div>

		${run.status !== "running"
			? html`<div class="tests-triple">
					<${NameList} title="new failures" names=${run.newFailures} tone="bad" empty="No new failures" />
					<${NameList} title="fixed" names=${run.fixed} tone="ok" empty="Nothing newly fixed" />
					<${NameList} title="flaky" names=${run.flaky} tone="warn" empty="No flaky tests detected" />
				</div>`
			: null}

		<div class="card">
			<div class="row" style="margin-bottom:10px"><h3 style="font-size:15px">Trend</h3><span class="tiny faint">same cwd + command</span></div>
			<${TrendChart} runs=${history} currentId=${run.id} />
		</div>

		<div class="card">
			<div class="row" style="margin-bottom:10px">
				<h3 style="font-size:15px">Tests</h3>
				<span class="tiny faint">${run.tests?.length ?? 0} parsed</span>
			</div>
			${tree.length
				? html`<div class="col" style="gap:6px">${tree.map((group) => html`<${TestGroup} key=${`${run.id}:${group.name}`} group=${group} />`)}</div>`
				: html`<div class="small faint">${run.status === "running" ? "Waiting for the run to finish…" : "No individual tests could be parsed from the output."}</div>`}
		</div>

		<div class="card">
			<div class="row" style="cursor:pointer" onClick=${() => setShowRaw(!showRaw)}>
				<span class="faint">${showRaw ? "▾" : "▸"}</span>
				<h3 style="font-size:15px">Raw output</h3>
				<span class="tiny faint">tail</span>
			</div>
			${showRaw ? html`<pre class="code-block tall" style="margin-top:10px">${run.outputTail || "(no output)"}</pre>` : null}
		</div>
	</div>`;
}

function RunForm({ onClose }) {
	const state = useStore();
	const online = sorted(state.sessions, "createdAt", false).filter((s) => s.online);
	const [sessionId, setSessionId] = useState(online[0]?.id ?? "");
	const [cwd, setCwd] = useState(online[0]?.cwd ?? "");
	const [command, setCommand] = useState("");
	const [touched, setTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!cwd || touched) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			api("GET", `/api/tests-default?cwd=${encodeURIComponent(cwd)}`)
				.then((data) => !cancelled && setCommand(data.command ?? ""))
				.catch(() => {});
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [cwd, touched]);

	const pickSession = (id) => {
		setSessionId(id);
		const session = sessionOf(id);
		if (session?.cwd) setCwd(session.cwd);
	};

	const submit = async () => {
		setBusy(true);
		setError("");
		try {
			const result = await api("POST", "/api/tests/run", { sessionId: sessionId || undefined, cwd: cwd || undefined, command: command || undefined });
			onClose();
			navigate(`#/tests/${encodeURIComponent(result.id)}`);
		} catch (e) {
			setError(e.message);
		} finally {
			setBusy(false);
		}
	};

	return html`<div class="col" style="gap:14px">
		<h2>Run tests</h2>
		<label class="field">
			Session
			<select class="input" value=${sessionId} onChange=${(e) => pickSession(e.target.value)}>
				<option value="">— none (use cwd) —</option>
				${online.map((s) => html`<option value=${s.id}>${sessionName(s)} · ${s.cwd}</option>`)}
			</select>
		</label>
		<label class="field">
			Working directory
			<input class="input mono" value=${cwd} placeholder="/abs/path/to/repo" onInput=${(e) => setCwd(e.target.value)} />
		</label>
		<label class="field">
			Command
			<input
				class="input mono"
				value=${command}
				placeholder="auto-detected from the repo"
				onInput=${(e) => {
					setTouched(true);
					setCommand(e.target.value);
				}}
				onKeyDown=${(e) => e.key === "Enter" && submit()}
			/>
		</label>
		${error ? html`<div class="small" style="color:var(--bad)">${error}</div>` : null}
		<div class="row">
			<span class="spacer"></span>
			<button class="btn ghost" onClick=${onClose}>Cancel</button>
			<button class="btn primary" disabled=${busy || (!cwd && !sessionId)} onClick=${submit}>▶ Run</button>
		</div>
	</div>`;
}

export function TestsView({ id }) {
	const state = useStore();
	useTick(5000);
	const [filter, setFilter] = useState(null);
	const [showForm, setShowForm] = useState(false);
	const runs = sorted(state.testRuns, "createdAt", true);
	const sessionIds = [...new Set(runs.map((r) => r.sessionId).filter(Boolean))];
	const visible = filter ? runs.filter((r) => (filter === "hub" ? !r.sessionId : r.sessionId === filter)) : runs;
	const selected = (id && state.testRuns.get(id)) || visible[0] || runs[0];
	const history = selected
		? runs
				.filter((r) => r.cwd === selected.cwd && r.command === selected.command && r.status !== "running")
				.slice(0, 15)
				.reverse()
		: [];
	const failing = runs.filter((r) => r.status === "failed" || r.status === "error").length;

	return html`<div class="page">
		<div class="page-head">
			<div>
				<div class="page-title">Tests</div>
				<div class="page-sub">${runs.length} run${runs.length === 1 ? "" : "s"} · ${failing} failing · ${runs.filter((r) => r.status === "running").length} running</div>
			</div>
			<span class="spacer"></span>
			<button class="btn primary" onClick=${() => setShowForm(true)}>▶ Run tests</button>
		</div>

		${runs.length
			? html`<div class="split list-first">
					<div class="col" style="gap:12px;min-width:0">
						<div class="row wrap">
							<button class=${`chip ${filter ? "" : "on"}`} onClick=${() => setFilter(null)}>All</button>
							${sessionIds.map((sid) => html`<${SessionChip} id=${sid} on=${filter === sid} onClick=${() => setFilter(filter === sid ? null : sid)} />`)}
							${runs.some((r) => !r.sessionId) ? html`<button class=${`chip ${filter === "hub" ? "on" : ""}`} onClick=${() => setFilter(filter === "hub" ? null : "hub")}>hub</button>` : null}
						</div>
						<div class="card" style="padding:8px">
							<div class="col" style="gap:4px">
								${visible.map((run) => html`<${RunRow} key=${run.id} run=${run} active=${selected?.id === run.id} />`)}
								${visible.length ? null : html`<div class="small faint" style="padding:12px">No runs for this filter.</div>`}
							</div>
						</div>
					</div>
					<div style="min-width:0">${selected ? html`<${RunDetail} key=${selected.id} run=${selected} history=${history} />` : null}</div>
				</div>`
			: html`<${Empty} icon="✓" title="No test runs yet">Agents report test runs automatically, or start one with <b>Run tests</b>.<//>`}
		${showForm ? html`<${Modal} onClose=${() => setShowForm(false)}><${RunForm} onClose=${() => setShowForm(false)} /><//>` : null}
	</div>`;
}
