import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js";
import { api, sessionOf, sorted, useStore } from "../lib/store.js";
import { Empty, Modal, SessionChip, colorOf, sessionName, timeAgo, useTick } from "../lib/util.js";
import { SpawnDialog } from "./agents.js";

const COLUMNS = [
	{ status: "todo", label: "To do", icon: "○" },
	{ status: "doing", label: "Doing", icon: "◐" },
	{ status: "review", label: "Review", icon: "◧" },
	{ status: "blocked", label: "Blocked", icon: "⛔" },
	{ status: "done", label: "Done", icon: "✓" },
];

const STATUS_COLOR = {
	todo: "var(--ink-faint)",
	doing: "var(--vfd)",
	review: "var(--warn)",
	blocked: "var(--bad)",
	done: "var(--ok)",
};

const NODE_WIDTH = 240;
const NODE_HEIGHT = 56;
const COLUMN_GAP = 90;
const ROW_GAP = 20;
const PADDING = 24;

function patchTask(id, body) {
	return api("PATCH", `/api/tasks/${encodeURIComponent(id)}`, body).catch((error) => alert(error.message));
}

function TaskCard({ task, tasks, onOpen, onDragState }) {
	const owner = task.owner ? sessionOf(task.owner) : null;
	const deps = (task.deps ?? []).filter((d) => tasks.has(d));
	const openDeps = deps.filter((d) => tasks.get(d)?.status !== "done").length;
	return html`<div
		class="card task-card"
		style=${`--c:${owner ? colorOf(owner) : "var(--line-strong)"}`}
		draggable="true"
		onDragStart=${(e) => {
			e.dataTransfer.setData("text/plain", task.id);
			e.dataTransfer.effectAllowed = "move";
			onDragState(task.id);
		}}
		onDragEnd=${() => onDragState(null)}
		onClick=${() => onOpen(task.id)}
	>
		<div class="accent-bar"></div>
		<div class="task-title">${task.title || "(untitled)"}</div>
		${task.description ? html`<div class="tiny muted task-desc">${task.description}</div>` : null}
		<div class="row wrap tiny" style="margin-top:8px">
			${task.owner ? html`<${SessionChip} id=${task.owner} static=${true} />` : html`<span class="pill">unassigned</span>`}
			<span class="spacer"></span>
			${deps.length ? html`<span class=${`pill ${openDeps ? "" : "ok"}`} title=${`${deps.length} dependenc${deps.length === 1 ? "y" : "ies"}, ${deps.length - openDeps} done`}>⇠ ${deps.length - openDeps}/${deps.length}</span>` : null}
			${task.notes?.length ? html`<span class="pill" title="notes">✎ ${task.notes.length}</span>` : null}
		</div>
	</div>`;
}

const ACTIVE_STATUSES = new Set(["doing", "review", "done"]);

function Board({ tasks, onOpen }) {
	const [dragging, setDragging] = useState(null);
	const [over, setOver] = useState(null);
	const [warning, setWarning] = useState(null);
	const warningTimer = useRef();
	useEffect(() => () => clearTimeout(warningTimer.current), []);
	const warn = (text) => {
		setWarning(text);
		clearTimeout(warningTimer.current);
		warningTimer.current = setTimeout(() => setWarning(null), 5000);
	};
	const list = sorted(tasks, "createdAt", false);
	const drop = (e, status) => {
		e.preventDefault();
		const id = e.dataTransfer.getData("text/plain") || dragging;
		setOver(null);
		setDragging(null);
		const task = tasks.get(id);
		if (!task || task.status === status) return;
		patchTask(id, { status });
		const blockers = (task.deps ?? []).map((d) => tasks.get(d)).filter((d) => d && d.status !== "done");
		if (ACTIVE_STATUSES.has(status) && blockers.length) {
			warn(`“${task.title || "(untitled)"}” moved to ${status}, but it is blocked by ${blockers.map((d) => `“${d.title || "(untitled)"}”`).join(", ")}.`);
		}
	};
	return html`${warning ? html`<div class="task-flash" role="status">⚠ ${warning}</div>` : null}<div class="kanban">
		${COLUMNS.map((column) => {
			const items = list.filter((t) => (t.status ?? "todo") === column.status);
			return html`<div
				class=${`kanban-col ${over === column.status ? "drop" : ""}`}
				style=${`--c:${STATUS_COLOR[column.status]}`}
				onDragOver=${(e) => {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					if (over !== column.status) setOver(column.status);
				}}
				onDragLeave=${(e) => !e.currentTarget.contains(e.relatedTarget) && setOver(null)}
				onDrop=${(e) => drop(e, column.status)}
			>
				<div class="kanban-head">
					<span class="dot" style=${`--c:${STATUS_COLOR[column.status]}`}></span>
					<span>${column.label}</span>
					<span class="spacer"></span>
					<span class="pill">${items.length}</span>
				</div>
				<div class="col" style="gap:10px">
					${items.map((task) => html`<${TaskCard} key=${task.id} task=${task} tasks=${tasks} onOpen=${onOpen} onDragState=${setDragging} />`)}
					${items.length ? null : html`<div class="tiny faint kanban-empty">Drop tasks here</div>`}
				</div>
			</div>`;
		})}
	</div>`;
}

function layoutGraph(tasks) {
	const memo = new Map();
	const visiting = new Set();
	const depth = (id) => {
		if (memo.has(id)) return memo.get(id);
		if (visiting.has(id)) return 0;
		visiting.add(id);
		let value = 0;
		for (const dep of tasks.get(id)?.deps ?? []) {
			if (tasks.has(dep) && dep !== id) value = Math.max(value, depth(dep) + 1);
		}
		visiting.delete(id);
		memo.set(id, value);
		return value;
	};
	for (const id of tasks.keys()) depth(id);

	const buckets = [];
	for (const task of sorted(tasks, "createdAt", false)) {
		const layer = memo.get(task.id) ?? 0;
		(buckets[layer] ??= []).push(task);
	}
	const layers = buckets.filter(Boolean);
	const positions = new Map();
	layers.forEach((layer, index) => {
		if (index > 0) {
			const center = (task) => {
				const ys = (task.deps ?? []).map((d) => positions.get(d)?.y).filter((y) => y != null);
				return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.MAX_SAFE_INTEGER;
			};
			layer.sort((a, b) => center(a) - center(b));
		}
		layer.forEach((task, row) => {
			positions.set(task.id, { x: PADDING + index * (NODE_WIDTH + COLUMN_GAP), y: PADDING + row * (NODE_HEIGHT + ROW_GAP) });
		});
	});

	const edges = [];
	for (const task of tasks.values()) {
		for (const dep of task.deps ?? []) {
			if (!tasks.has(dep) || dep === task.id) continue;
			edges.push({ from: dep, to: task.id, cyclic: (memo.get(dep) ?? 0) >= (memo.get(task.id) ?? 0) });
		}
	}
	const tallest = Math.max(1, ...layers.map((l) => l.length));
	return {
		positions,
		edges,
		width: PADDING * 2 + layers.length * NODE_WIDTH + Math.max(0, layers.length - 1) * COLUMN_GAP,
		height: PADDING * 2 + tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP,
	};
}

function edgePath(from, to, cyclic) {
	if (cyclic) {
		const x1 = from.x + NODE_WIDTH / 2;
		const y1 = from.y + NODE_HEIGHT;
		const x2 = to.x + NODE_WIDTH / 2;
		const y2 = to.y + NODE_HEIGHT;
		const dip = Math.max(y1, y2) + 40;
		return `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2 + 6}`;
	}
	const x1 = from.x + NODE_WIDTH;
	const y1 = from.y + NODE_HEIGHT / 2;
	const x2 = to.x - 6;
	const y2 = to.y + NODE_HEIGHT / 2;
	const bend = Math.max(30, (x2 - x1) / 2);
	return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function truncate(text, max) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function Graph({ tasks, onOpen }) {
	const { positions, edges, width, height } = useMemo(() => layoutGraph(tasks), [tasks, [...tasks.values()].map((t) => `${t.id}:${t.status}:${(t.deps ?? []).join(",")}`).join("|")]);
	const hasCycle = edges.some((e) => e.cyclic);
	return html`<div class="card graph-card">
		<div class="row wrap tiny muted" style="margin-bottom:10px">
			${COLUMNS.map((c) => html`<span class="row" style="gap:5px"><span class="legend-swatch" style=${`background:${STATUS_COLOR[c.status]}`}></span>${c.label}</span>`)}
			<span class="spacer"></span>
			<span class="faint">outline = owner · arrow = dependency → dependent</span>
			${hasCycle ? html`<span class="pill bad">cycle detected</span>` : null}
		</div>
		<div class="graph-wrap">
			<svg width=${width} height=${height + 50} viewBox=${`0 0 ${width} ${height + 50}`} class="task-graph">
				<defs>
					<marker id="task-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
						<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-soft)" />
					</marker>
					<marker id="task-arrow-bad" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
						<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--bad)" />
					</marker>
				</defs>
				${edges.map((edge) => {
					const from = positions.get(edge.from);
					const to = positions.get(edge.to);
					if (!from || !to) return null;
					const done = tasks.get(edge.from)?.status === "done";
					return html`<path
						d=${edgePath(from, to, edge.cyclic)}
						fill="none"
						stroke=${edge.cyclic ? "var(--bad)" : done ? "var(--ok)" : "var(--ink-soft)"}
						stroke-opacity=${done ? 0.55 : 0.8}
						stroke-width="2"
						stroke-dasharray=${edge.cyclic ? "5 4" : null}
						marker-end=${edge.cyclic ? "url(#task-arrow-bad)" : "url(#task-arrow)"}
					/>`;
				})}
				${[...tasks.values()].map((task) => {
					const pos = positions.get(task.id);
					if (!pos) return null;
					const owner = task.owner ? sessionOf(task.owner) : null;
					const status = task.status ?? "todo";
					return html`<g class="graph-node" transform=${`translate(${pos.x} ${pos.y})`} onClick=${() => onOpen(task.id)}>
						<title>${`${task.title}\n${status}${owner ? ` · ${sessionName(owner)}` : ""}`}</title>
						<rect width=${NODE_WIDTH} height=${NODE_HEIGHT} rx="7" fill="#232321" stroke="var(--line-strong)" stroke-width="1" />${owner ? html`<circle cx=${NODE_WIDTH - 14} cy="14" r="4" fill=${colorOf(owner)} />` : null}
						<rect x="0" y="0" width="6" height=${NODE_HEIGHT} rx="2" fill=${STATUS_COLOR[status] ?? "var(--ink-faint)"} />
						<text x="18" y="23" fill="var(--ink)" font-size="13" font-weight="500">${truncate(task.title || "(untitled)", 28)}</text>
						<text x="18" y="42" fill="var(--ink-soft)" font-size="11">${status}${owner ? ` · ${truncate(sessionName(owner), 16)}` : ""}</text>
					</g>`;
				})}
			</svg>
		</div>
	</div>`;
}

function TaskEditor({ task, tasks, onClose }) {
	const state = useStore();
	const isNew = !task;
	const sessions = sorted(state.sessions, "createdAt", false);
	const [title, setTitle] = useState(task?.title ?? "");
	const [description, setDescription] = useState(task?.description ?? "");
	const [owner, setOwner] = useState(task?.owner ?? "");
	const [status, setStatus] = useState(task?.status ?? "todo");
	const [deps, setDeps] = useState(() => new Set(task?.deps ?? []));
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [spawning, setSpawning] = useState(false);
	const candidates = sorted(tasks, "createdAt", false).filter((t) => t.id !== task?.id);

	const toggleDep = (id) =>
		setDeps((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const save = async () => {
		if (!title.trim()) return;
		setBusy(true);
		try {
			const body = { title: title.trim(), description, owner: owner || null, deps: [...deps].filter((d) => tasks.has(d)) };
			if (isNew) await api("POST", "/api/tasks", { ...body, owner: owner || undefined, status });
			else await api("PATCH", `/api/tasks/${encodeURIComponent(task.id)}`, { ...body, status });
			onClose();
		} catch (error) {
			alert(error.message);
		} finally {
			setBusy(false);
		}
	};

	const addNote = async () => {
		if (!note.trim()) return;
		await patchTask(task.id, { note: note.trim(), by: "human" });
		setNote("");
	};

	const remove = async () => {
		if (!confirm(`Delete task "${task.title}"?`)) return;
		await api("DELETE", `/api/tasks/${encodeURIComponent(task.id)}`).catch((error) => alert(error.message));
		onClose();
	};

	const live = task ? (state.tasks.get(task.id) ?? task) : null;

	if (spawning && live) return html`<${SpawnDialog} task=${live} onClose=${() => setSpawning(false)} />`;

	return html`<div class="col" style="gap:14px">
		<div class="row">
			<h2>${isNew ? "New task" : "Edit task"}</h2>
			<span class="spacer"></span>
			${live ? html`<span class="tiny faint">created ${timeAgo(live.createdAt)} ago</span>` : null}
		</div>
		<label class="field">
			Title
			<input class="input" value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
		</label>
		<label class="field">
			Description
			<textarea class="input" value=${description} onInput=${(e) => setDescription(e.target.value)} placeholder="Context, acceptance criteria…"></textarea>
		</label>
		<div class="row" style="gap:12px;align-items:flex-start">
			<label class="field" style="flex:1">
				Owner
				<select class="input" value=${owner} onChange=${(e) => setOwner(e.target.value)}>
					<option value="">unassigned</option>
					${sessions.map((s) => html`<option value=${s.id}>${sessionName(s)}${s.online ? "" : " (offline)"}</option>`)}
				</select>
			</label>
			<label class="field" style="flex:1">
				Status
				<select class="input" value=${status} onChange=${(e) => setStatus(e.target.value)}>
					${COLUMNS.map((c) => html`<option value=${c.status}>${c.label}</option>`)}
				</select>
			</label>
		</div>
		<div class="col" style="gap:6px">
			<span class="small muted">Depends on</span>
			${candidates.length
				? html`<div class="well dep-picker">
						${candidates.map(
							(t) => html`<label class="row small dep-option">
								<input type="checkbox" checked=${deps.has(t.id)} onChange=${() => toggleDep(t.id)} />
								<span class="dot" style=${`--c:${STATUS_COLOR[t.status ?? "todo"]};width:8px;height:8px`}></span>
								<span class="ellipsis" style="flex:1">${t.title || "(untitled)"}</span>
								<span class="tiny faint">${t.status}</span>
							</label>`,
						)}
					</div>`
				: html`<div class="tiny faint">No other tasks yet.</div>`}
		</div>
		${live
			? html`<div class="col" style="gap:6px">
					<span class="small muted">Notes</span>
					<div class="col" style="gap:6px">
						${(live.notes ?? []).map(
							(n) => html`<div class="well small" style="padding:8px 12px">
								<div class="row tiny faint">
									${n.by && n.by !== "human" && sessionOf(n.by) ? html`<${SessionChip} id=${n.by} static=${true} />` : html`<span>${n.by === "human" ? "you" : (n.by ?? "")}</span>`}
									<span class="spacer"></span>
									<span>${timeAgo(n.at)}</span>
								</div>
								<div style="white-space:pre-wrap;margin-top:4px">${n.text}</div>
							</div>`,
						)}
						<div class="row">
							<input class="input" value=${note} placeholder="Add a note…" onInput=${(e) => setNote(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && addNote()} />
							<button class="btn" disabled=${!note.trim()} onClick=${addNote}>Add</button>
						</div>
					</div>
				</div>`
			: null}
		<div class="row">
			${live ? html`<button class="btn bad" onClick=${remove}>Delete</button>` : null}
			${live ? html`<button class="btn" title="Launch a new pi agent briefed on this task" onClick=${() => setSpawning(true)}>Spawn agent for this task</button>` : null}
			<span class="spacer"></span>
			<button class="btn ghost" onClick=${onClose}>Cancel</button>
			<button class="btn primary" disabled=${busy || !title.trim()} onClick=${save}>${isNew ? "Create" : "Save"}</button>
		</div>
	</div>`;
}

export function TasksView() {
	const state = useStore();
	useTick(30000);
	const [mode, setMode] = useState("board");
	const [editing, setEditing] = useState(null);
	const tasks = state.tasks;
	const all = [...tasks.values()];
	const counts = Object.fromEntries(COLUMNS.map((c) => [c.status, all.filter((t) => (t.status ?? "todo") === c.status).length]));
	const editingTask = editing && editing !== "new" ? tasks.get(editing) : null;

	return html`<div class="page">
		<div class="page-head">
			<div>
				<div class="page-title">Tasks</div>
				<div class="page-sub">${all.length} task${all.length === 1 ? "" : "s"} · ${counts.doing} doing · ${counts.blocked} blocked · ${counts.done} done</div>
			</div>
			<span class="spacer"></span>
			<div class="segmented">
				<button class=${mode === "board" ? "on" : ""} onClick=${() => setMode("board")}>Board</button>
				<button class=${mode === "graph" ? "on" : ""} onClick=${() => setMode("graph")}>Graph</button>
			</div>
			<button class="btn primary" onClick=${() => setEditing("new")}>New task</button>
		</div>
		${all.length
			? mode === "board"
				? html`<${Board} tasks=${tasks} onOpen=${setEditing} />`
				: html`<${Graph} tasks=${tasks} onOpen=${setEditing} />`
			: html`<${Empty} icon="☰" title="No tasks yet">Create a task here, or let agents add them with the hub tools.<//>`}
		${editing && (editing === "new" || editingTask)
			? html`<${Modal} width=${620} onClose=${() => setEditing(null)}><${TaskEditor} key=${editing} task=${editingTask} tasks=${tasks} onClose=${() => setEditing(null)} /><//>`
			: null}
	</div>`;
}
