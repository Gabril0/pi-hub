import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js";
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from "../lib/graph-layout.js";
import { api, sessionOf, toast, useStore } from "../lib/store.js";
import { Empty, Markdown, Modal, colorOf, isTyping, navigate, sessionName, timeAgo } from "../lib/util.js";
import { MermaidView } from "./diagram.js";

const ROOT = "root";
const EDGE_KINDS = [
	{ kind: "http", label: "HTTP calls" },
	{ kind: "event", label: "Events" },
	{ kind: "package", label: "Packages" },
	{ kind: "store", label: "Data stores" },
	{ kind: "import", label: "Imports" },
	{ kind: "link", label: "Noted links" },
];
const KIND_LABEL = { workspace: "workspace", repo: "repository", domain: "domain", file: "file", symbol: "symbol", store: "data store", external: "external service" };
const KIND_MARK = { repo: "R", domain: "D", file: "F", symbol: "ƒ", store: "DB", external: "↗", workspace: "W" };
const CONFIDENCE = { confirmed: "matched in code", likely: "likely", possible: "possible, several candidates", stated: "stated by a person or agent" };

function graphHref(id) {
	return id === ROOT ? "#/graph" : `#/graph/${encodeURIComponent(id)}`;
}

function clip(text, max) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function fitCamera(layout, box) {
	if (!box.width || !box.height) return { k: 1, x: 0, y: 0 };
	const k = Math.min((box.width - 56) / Math.max(layout.width, 1), (box.height - 56) / Math.max(layout.height, 1), 1.15);
	return { k, x: (box.width - layout.width * k) / 2, y: (box.height - layout.height * k) / 2 };
}

function GraphNode({ node, selected, dimmed, onSelect, onOpen }) {
	const agents = node.agents ?? [];
	return html`<g
		class=${`gnode kind-${node.kind} ${node.ghost ? "ghost" : ""} ${node.self ? "self" : ""} ${selected ? "selected" : ""} ${dimmed ? "dimmed" : ""}`}
		transform=${`translate(${node.x} ${node.y})`}
		data-node=${node.id}
		tabindex="0"
		role="button"
		aria-label=${`${KIND_LABEL[node.kind] ?? node.kind} ${node.label}, ${node.sub}${node.drillable ? ", double click to zoom in" : ""}`}
		onClick=${(e) => (e.stopPropagation(), onSelect(node.id))}
		onDblClick=${(e) => (e.stopPropagation(), node.drillable && onOpen(node.id))}
		onKeyDown=${(e) => {
			if (e.key === "Enter" && node.drillable) onOpen(node.id);
			else if (e.key === " ") (e.preventDefault(), onSelect(node.id));
		}}
	>
		<title>${node.label}${node.path ? `\n${node.path}` : ""}</title>
		<rect class="gnode-box" width=${NODE_WIDTH} height=${NODE_HEIGHT} rx="9" />
		<rect class="gnode-bar" width="4" height=${NODE_HEIGHT - 20} x="7" y="10" rx="2" />
		<text class="gnode-mark" x=${NODE_WIDTH - 12} y="20" text-anchor="end">${KIND_MARK[node.kind] ?? ""}</text>
		<text class="gnode-label" x="20" y="26">${clip(node.label, node.kind === "symbol" ? 24 : 22)}</text>
		<text class="gnode-sub" x="20" y="45">${clip(node.sub, 26)}</text>
		${node.notes ? html`<g transform=${`translate(${NODE_WIDTH - 30} 34)`}><rect class="gnode-badge" width="20" height="16" rx="5" /><text class="gnode-badge-text" x="10" y="12" text-anchor="middle">${node.notes}</text></g>` : null}
		${agents.slice(0, 4).map((id, index) => html`<circle class="gnode-agent" cx=${20 + index * 13} cy=${NODE_HEIGHT} r="5" style=${`fill:${colorOf(id)}`}><title>${sessionName(sessionOf(id))} is working here</title></circle>`)}
	</g>`;
}

function GraphEdge({ edge, selected, dimmed, showLabel, onSelect }) {
	const text = edge.details?.[0] ?? (edge.count > 1 ? `${edge.count} ${edge.kind}s` : "");
	return html`<g class=${`gedge kind-${edge.kind} conf-${edge.confidence} ${selected ? "selected" : ""} ${dimmed ? "dimmed" : ""}`} onClick=${(e) => (e.stopPropagation(), onSelect(edge.id))}>
		<title>${edge.sentence}</title>
		<path class="gedge-hit" d=${edge.path} />
		<path class="gedge-line" d=${edge.path} marker-end=${`url(#arrow-${edge.kind})`} style=${`stroke-width:${Math.min(1.3 + Math.log2(edge.count), 4)}`} />
		${showLabel && text ? html`<text class="gedge-label" x=${edge.labelX} y=${edge.labelY - 5} text-anchor="middle">${clip(text, 22)}${edge.count > 1 && edge.details?.length ? ` +${edge.count - 1}` : ""}</text>` : null}
	</g>`;
}

function Canvas({ view, filters, selection, onSelect, onOpen, onUp }) {
	const box = useRef();
	const [camera, setCamera] = useState({ k: 1, x: 0, y: 0 });
	const cameraRef = useRef(camera);
	cameraRef.current = camera;
	const fitScale = useRef(1);
	const cooldown = useRef(0);
	const edges = useMemo(() => view.edges.filter((edge) => filters.has(edge.kind)), [view, filters]);
	const nodes = useMemo(() => {
		const used = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
		return view.nodes.filter((node) => (!node.ghost && !node.self) || used.has(node.id));
	}, [view, edges]);
	const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
	const fit = () => {
		const el = box.current;
		if (!el) return;
		const next = fitCamera(layout, { width: el.clientWidth, height: el.clientHeight });
		fitScale.current = next.k;
		setCamera(next);
	};
	useEffect(fit, [layout]);
	useEffect(() => {
		const observer = new ResizeObserver(fit);
		observer.observe(box.current);
		return () => observer.disconnect();
	}, [layout]);
	const zoomAt = (factor, px, py) => {
		const { k, x, y } = cameraRef.current;
		const next = Math.min(fitScale.current * 3.2, Math.max(fitScale.current * 0.4, k * factor));
		setCamera({ k: next, x: px - ((px - x) / k) * next, y: py - ((py - y) / k) * next });
		return next;
	};
	useEffect(() => {
		const el = box.current;
		const onWheel = (event) => {
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			const next = zoomAt(Math.exp(-event.deltaY * 0.0016), event.clientX - rect.left, event.clientY - rect.top);
			if (Date.now() < cooldown.current) return;
			const ratio = next / fitScale.current;
			const nodeId = event.target.closest?.("[data-node]")?.dataset.node;
			const node = view.nodes.find((n) => n.id === nodeId);
			if (ratio >= 2.6 && node?.drillable) {
				cooldown.current = Date.now() + 700;
				onOpen(node.id);
			} else if (ratio <= 0.5 && view.focus.id !== ROOT) {
				cooldown.current = Date.now() + 700;
				onUp();
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [view]);
	const startPan = (event) => {
		if (event.button !== 0) return;
		const origin = { px: event.clientX, py: event.clientY, ...cameraRef.current };
		const move = (e) => setCamera({ k: origin.k, x: origin.x + e.clientX - origin.px, y: origin.y + e.clientY - origin.py });
		const stop = () => {
			removeEventListener("pointermove", move);
			removeEventListener("pointerup", stop);
		};
		addEventListener("pointermove", move);
		addEventListener("pointerup", stop);
	};
	const zoomButton = (factor) => {
		const el = box.current;
		zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
	};
	const active = selection?.type === "edge" ? edges.find((edge) => edge.id === selection.id) : null;
	const related = selection?.type === "node" ? new Set([selection.id, ...edges.filter((edge) => edge.from === selection.id || edge.to === selection.id).flatMap((edge) => [edge.from, edge.to])]) : active ? new Set([active.from, active.to]) : null;
	const edgeOn = (edge) => (selection?.type === "node" ? edge.from === selection.id || edge.to === selection.id : selection?.type === "edge" ? edge.id === selection.id : true);
	return html`<div class="graph-canvas" ref=${box} onPointerDown=${startPan} onClick=${() => onSelect(null)}>
		<svg width="100%" height="100%" class="graph-svg" aria-label=${`Graph of ${view.focus.label}`}>
			<defs>
				${EDGE_KINDS.map(({ kind }) => html`<marker id=${`arrow-${kind}`} class=${`arrow kind-${kind}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L8 4 L0 8 z" /></marker>`)}
			</defs>
			<g transform=${`translate(${camera.x} ${camera.y}) scale(${camera.k})`}>
				${layout.edges.map((edge) => html`<${GraphEdge} key=${edge.id} edge=${edge} selected=${selection?.id === edge.id} dimmed=${!edgeOn(edge)} showLabel=${layout.edges.length <= 12 || edgeOn(edge) && Boolean(selection)} onSelect=${(id) => onSelect({ type: "edge", id })} />`)}
				${layout.nodes.map((node) => html`<${GraphNode} key=${node.id} node=${node} selected=${selection?.id === node.id} dimmed=${related ? !related.has(node.id) : false} onSelect=${(id) => onSelect({ type: "node", id })} onOpen=${onOpen} />`)}
			</g>
		</svg>
		${!layout.nodes.length ? html`<div class="graph-hint">Nothing to show at this level.</div>` : null}
		<div class="graph-zoom" onClick=${(e) => e.stopPropagation()} onPointerDown=${(e) => e.stopPropagation()}>
			<button class="btn sm icon" title="Zoom in" aria-label="Zoom in" onClick=${() => zoomButton(1.25)}>+</button>
			<button class="btn sm icon" title="Zoom out" aria-label="Zoom out" onClick=${() => zoomButton(0.8)}>−</button>
			<button class="btn sm" title="Fit to screen (f)" onClick=${fit}>Fit</button>
		</div>
		<div class="graph-help tiny faint">Scroll into a box to zoom through it · scroll out to go up · double-click to open</div>
	</div>`;
}

function SearchBox({ inputRef }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState([]);
	useEffect(() => {
		if (!query.trim()) return setResults([]);
		let alive = true;
		const timer = setTimeout(() => {
			api("GET", `/api/knowledge/search?q=${encodeURIComponent(query)}`)
				.then((data) => alive && setResults(data.results))
				.catch(() => {});
		}, 140);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [query]);
	const go = (result) => {
		setQuery("");
		navigate(graphHref(result.id));
	};
	return html`<div class="graph-search">
		<input
			ref=${inputRef}
			class="input"
			placeholder="Find a repo, folder, file or function… ( / )"
			aria-label="Search the graph"
			value=${query}
			onInput=${(e) => setQuery(e.target.value)}
			onKeyDown=${(e) => {
				if (e.key === "Enter" && results[0]) go(results[0]);
				if (e.key === "Escape") setQuery("");
			}}
		/>
		${results.length
			? html`<div class="graph-results card">
					${results.map((r) => html`<button class="graph-result" onClick=${() => go(r)}><span class="pill">${KIND_LABEL[r.kind] ?? r.kind}</span><span class="ellipsis">${r.label}</span><span class="tiny faint ellipsis">${[r.repo, r.path].filter(Boolean).join(" / ")}</span></button>`)}
				</div>`
			: null}
	</div>`;
}

function NotesSection({ targetId, label }) {
	const state = useStore();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const notes = [...state.notes.values()].filter((note) => note.target === targetId).sort((a, b) => b.createdAt - a.createdAt);
	const add = async () => {
		if (!text.trim() || busy) return;
		setBusy(true);
		try {
			await api("POST", "/api/knowledge/notes", { target: targetId, text });
			setText("");
		} catch (error) {
			toast({ kind: "error", tone: "bad", title: "Could not save the note", body: error.message });
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="inspect-section">
		<h4>Notes</h4>
		${notes.map(
			(note) => html`<div class="graph-note" key=${note.id}>
				<${Markdown} text=${note.text} />
				<div class="row tiny faint">
					<span>${note.byName ?? "unknown"} · ${timeAgo(note.createdAt)}</span><span class="spacer"></span>
					<button class="link-btn" onClick=${() => api("DELETE", `/api/knowledge/notes/${encodeURIComponent(note.id)}`)}>remove</button>
				</div>
			</div>`,
		)}
		<textarea class="input" rows="2" aria-label=${`Add a note about ${label}`} placeholder=${`What should people know about ${clip(label, 24)}?`} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && add()}></textarea>
		<div class="row"><span class="tiny faint">Agents working here see these notes</span><span class="spacer"></span><button class="btn sm" disabled=${!text.trim() || busy} onClick=${add}>Add note</button></div>
	</div>`;
}

function LinkForm({ from, view }) {
	const [to, setTo] = useState("");
	const [label, setLabel] = useState("");
	const options = view.nodes.filter((node) => node.id !== from.id);
	if (!options.length) return null;
	const add = async () => {
		try {
			await api("POST", "/api/knowledge/links", { from: from.id, to, label });
			setLabel("");
			setTo("");
		} catch (error) {
			toast({ kind: "error", tone: "bad", title: "Could not add the link", body: error.message });
		}
	};
	return html`<details class="inspect-section">
		<summary class="small muted">Add a relationship the scan missed</summary>
		<div class="col" style="gap:6px;margin-top:8px">
			<select class="input" aria-label="Connect to" value=${to} onChange=${(e) => setTo(e.target.value)}>
				<option value="">Connect to…</option>
				${options.map((node) => html`<option value=${node.id}>${node.label}</option>`)}
			</select>
			<input class="input" aria-label="Relationship" placeholder="e.g. replays failed orders nightly" value=${label} onInput=${(e) => setLabel(e.target.value)} />
			<div class="row"><span class="spacer"></span><button class="btn sm" disabled=${!to || !label.trim()} onClick=${add}>Add link</button></div>
		</div>
	</details>`;
}

function Connections({ edges, onSelect }) {
	if (!edges.length) return html`<div class="inspect-section"><h4>Connections</h4><div class="small faint">No connections found at this level.</div></div>`;
	return html`<div class="inspect-section">
		<h4>How it connects</h4>
		<div class="col" style="gap:2px">
			${edges.slice(0, 30).map((edge) => html`<button class="connection" onClick=${() => onSelect({ type: "edge", id: edge.id })}><span class=${`edge-dot kind-${edge.kind}`}></span><span>${edge.sentence}</span></button>`)}
		</div>
		${edges.length > 30 ? html`<div class="tiny faint">+${edges.length - 30} more</div>` : null}
	</div>`;
}

function EdgeInspector({ edge, view, onBack }) {
	const openEvidence = (item) => {
		if (item.line && item.repo) navigate(graphHref(`file:${item.repo}:${item.file}`));
	};
	const nodeLabel = (id) => view.nodes.find((node) => node.id === id)?.label ?? id;
	return html`<div class="inspector-body">
		<button class="link-btn small" onClick=${onBack}>‹ Back</button>
		<div class="row wrap"><span class=${`pill edge-pill kind-${edge.kind}`}>${EDGE_KINDS.find((k) => k.kind === edge.kind)?.label ?? edge.kind}</span><span class="pill">${CONFIDENCE[edge.confidence] ?? edge.confidence}</span></div>
		<h3 class="inspect-title">${nodeLabel(edge.from)} → ${nodeLabel(edge.to)}</h3>
		<div class="small">${edge.sentence}</div>
		${edge.details?.length
			? html`<div class="inspect-section"><h4>${edge.kind === "import" ? "What is used" : "What travels here"}</h4>${edge.details.map((detail) => html`<code class="detail-chip">${detail}</code>`)}</div>`
			: null}
		<div class="inspect-section">
			<h4>Found in</h4>
			${edge.evidence.map((item) => (item.line && item.repo ? html`<button class="evidence mono tiny" onClick=${() => openEvidence(item)}>${item.file}:${item.line}</button>` : html`<div class="evidence mono tiny">${item.file}</div>`))}
			${edge.count > edge.evidence.length ? html`<div class="tiny faint">and ${edge.count - edge.evidence.length} more</div>` : null}
		</div>
		${edge.linkIds?.length ? html`<button class="btn sm" onClick=${() => Promise.all(edge.linkIds.map((id) => api("DELETE", `/api/knowledge/links/${encodeURIComponent(id)}`))).then(onBack)}>Remove this link</button>` : null}
	</div>`;
}

function RepoList() {
	const state = useStore();
	const [path, setPath] = useState("");
	const repos = [...state.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
	const add = async () => {
		try {
			await api("POST", "/api/knowledge/repos", { path: path.trim() });
			setPath("");
		} catch (error) {
			toast({ kind: "error", tone: "bad", title: "Could not add the folder", body: error.message });
		}
	};
	return html`<div class="inspect-section">
		<h4>Repositories</h4>
		${repos.map(
			(repo) => html`<div class="repo-row" key=${repo.id} title=${repo.root}>
				<a class="ellipsis" href=${graphHref(`repo:${repo.id}`)}>${repo.name}</a>
				<span class="spacer"></span>
				${repo.status === "ready" ? html`<span class="tiny faint">${repo.files} files${repo.truncated ? " (partial)" : ""}</span>` : html`<span class=${`pill ${repo.status === "error" ? "bad" : "accent"}`} title=${repo.error ?? ""}>${repo.status}</span>`}
				<button class="link-btn tiny" aria-label=${`Remove ${repo.name}`} onClick=${() => api("DELETE", `/api/knowledge/repos/${encodeURIComponent(repo.id)}`)}>✕</button>
			</div>`,
		)}
		<div class="row" style="gap:6px">
			<input class="input mono" style="flex:1;min-width:0" aria-label="Folder to add" placeholder="/path/to/repo" value=${path} onInput=${(e) => setPath(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && path.trim() && add()} />
			<button class="btn sm" disabled=${!path.trim()} onClick=${add}>Add</button>
		</div>
	</div>`;
}

function Inspector({ view, selection, onSelect, onOpen, onShowDiagram }) {
	const edge = selection?.type === "edge" ? view.edges.find((item) => item.id === selection.id) : null;
	if (edge) return html`<aside class="card graph-inspector"><${EdgeInspector} edge=${edge} view=${view} onBack=${() => onSelect(null)} /></aside>`;
	const node = (selection?.type === "node" && view.nodes.find((item) => item.id === selection.id)) || view.focus;
	const isFocus = node.id === view.focus.id;
	const edges = view.edges.filter((item) => isFocus || item.from === node.id || item.to === node.id);
	const askAgent = async () => {
		try {
			const result = await api("POST", "/api/knowledge/ask", { target: node.id });
			toast({ kind: "message", sessionId: result.sessionId, tone: "ok", title: "Asked the agent to document this", body: "Its notes will appear here." });
		} catch (error) {
			toast({ kind: "error", tone: "warn", title: "No agent available", body: error.message });
		}
	};
	const copy = async () => {
		await navigator.clipboard?.writeText(`\`\`\`mermaid\n${view.mermaid}\n\`\`\``);
		toast({ kind: "done", tone: "ok", title: "Mermaid copied" });
	};
	return html`<aside class="card graph-inspector">
		<div class="inspector-body">
			<div class="row wrap"><span class="pill">${KIND_LABEL[node.kind] ?? node.kind}</span>${node.ghost ? html`<span class="pill">outside this level</span>` : null}</div>
			<h3 class="inspect-title">${node.label}</h3>
			${node.path ? html`<div class="mono tiny faint ellipsis" title=${node.path}>${node.path}${node.line ? `:${node.line}` : ""}</div>` : null}
			${node.description ? html`<div class="small muted">${node.description}</div>` : null}
			${node.kind === "workspace" ? html`<div class="small muted">${view.nodes.filter((n) => n.kind === "repo").length} repositories, ${view.edges.length} connections.</div>` : html`<div class="small faint">${node.sub}</div>`}
			${node.agents?.length ? html`<div class="row wrap">${node.agents.map((id) => html`<span class="pill" style=${`color:${colorOf(id)}`}>● ${sessionName(sessionOf(id))}</span>`)}</div>` : null}
			<div class="row wrap">
				${node.drillable ? html`<button class="btn sm primary" onClick=${() => onOpen(node.id)}>Zoom in</button>` : null}
				${isFocus ? html`<button class="btn sm" onClick=${onShowDiagram}>Diagram</button><button class="btn sm ghost" onClick=${copy}>Copy Mermaid</button>` : null}
				${["repo", "domain", "file", "workspace"].includes(node.kind) ? html`<button class="btn sm ghost" onClick=${askAgent}>Ask an agent to document</button>` : null}
			</div>
			<${Connections} edges=${edges} onSelect=${onSelect} />
			<${NotesSection} key=${node.id} targetId=${node.id} label=${node.label} />
			${node.kind !== "workspace" ? html`<${LinkForm} key=${`link-${node.id}`} from=${node} view=${view} />` : null}
			${view.focus.id === ROOT && isFocus ? html`<${RepoList} /><div class="tiny faint">Written down as Markdown in <span class="mono">${view.docsDir}</span></div>` : null}
		</div>
	</aside>`;
}

export function GraphView({ focus }) {
	const state = useStore();
	const focusId = focus || ROOT;
	const [view, setView] = useState(null);
	const [error, setError] = useState(null);
	const [selection, setSelection] = useState(null);
	const [hiddenKinds, setHiddenKinds] = useState(() => new Set());
	const [diagram, setDiagram] = useState(false);
	const searchRef = useRef();
	const repos = [...state.repos.values()];
	const revision = `${repos.map((r) => `${r.id}:${r.scannedAt ?? 0}`).join(",")}|${state.notes.size}|${state.graphLinks.size}|${[...state.sessions.values()].filter((s) => s.online).length}`;
	useEffect(() => setSelection(null), [focusId]);
	useEffect(() => {
		let alive = true;
		api("GET", `/api/knowledge/view?focus=${encodeURIComponent(focusId)}`)
			.then((data) => {
				if (!alive) return;
				setView(data);
				setError(null);
			})
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, [focusId, revision]);
	const filters = useMemo(() => new Set(EDGE_KINDS.map((k) => k.kind).filter((kind) => !hiddenKinds.has(kind))), [hiddenKinds]);
	const open = (id) => navigate(graphHref(id));
	const goUp = () => {
		const crumbs = view?.crumbs ?? [];
		if (crumbs.length > 1) open(crumbs.at(-2).id);
	};
	useEffect(() => {
		const onKey = (e) => {
			if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
			if (e.key === "/") (e.preventDefault(), searchRef.current?.focus());
			else if (e.key === "Escape") setSelection(null);
			else if (e.key === "Backspace") (e.preventDefault(), goUp());
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	});
	const toggleKind = (kind) => {
		const next = new Set(hiddenKinds);
		next.has(kind) ? next.delete(kind) : next.add(kind);
		setHiddenKinds(next);
	};
	const scanning = repos.some((r) => ["scanning", "pending"].includes(r.status));
	const present = new Set(view?.edges.map((edge) => edge.kind));
	return html`<div class="page graph-page">
		<div class="page-head graph-head">
			<div>
				<h1 class="page-title">Graph</h1>
				<nav class="graph-crumbs" aria-label="Zoom level">
					${(view?.crumbs ?? []).map((crumb, index, list) => html`${index ? html`<span class="faint">›</span>` : null}<a class=${index === list.length - 1 ? "on" : ""} href=${graphHref(crumb.id)} title=${KIND_LABEL[crumb.kind]}>${crumb.label}</a>`)}
				</nav>
			</div>
			<span class="spacer"></span>
			<${SearchBox} inputRef=${searchRef} />
			<button class="btn sm" disabled=${scanning || !repos.length} onClick=${() => api("POST", "/api/knowledge/scan", {})}>${scanning ? "Scanning…" : "Rescan"}</button>
		</div>
		${error ? html`<${Empty} title="This part of the graph is gone">${error}. <a href="#/graph">Back to the workspace</a><//>` : null}
		${!error && view && !repos.length
			? html`<div class="graph-empty">
					<${Empty} icon="◎" title="No repositories yet">Connected agents add their repository automatically. You can also add a folder here.<//>
					<div class="card" style="max-width:520px;margin:0 auto"><${RepoList} /></div>
				</div>`
			: null}
		${!error && view && repos.length
			? html`<div class="graph-legend" role="group" aria-label="Connection types">
						${EDGE_KINDS.filter(({ kind }) => present.has(kind)).map(({ kind, label }) => html`<button class=${`legend-chip kind-${kind} ${hiddenKinds.has(kind) ? "off" : ""}`} aria-pressed=${!hiddenKinds.has(kind)} onClick=${() => toggleKind(kind)}><span class=${`edge-dot kind-${kind}`}></span>${label}</button>`)}
						${view.hidden ? html`<span class="tiny faint">${view.hidden} smaller items hidden, use search to reach them</span>` : null}
					</div>
					<div class="graph-body">
						<div class="card graph-card">
							<${Canvas} view=${view} filters=${filters} selection=${selection} onSelect=${setSelection} onOpen=${open} onUp=${goUp} />
						</div>
						<${Inspector} view=${view} selection=${selection} onSelect=${setSelection} onOpen=${open} onShowDiagram=${() => setDiagram(true)} />
					</div>`
			: null}
		${diagram && view
			? html`<${Modal} width=${1200} onClose=${() => setDiagram(false)}>
					<h2 style="margin-bottom:12px">${view.focus.label}</h2>
					<div class="explain-full"><${MermaidView} source=${view.mermaid} /></div>
				<//>`
			: null}
	</div>`;
}
