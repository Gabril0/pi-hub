import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, toast, useStore } from "../lib/store.js";
import { Modal, Switch } from "../lib/util.js";

let loading;
let queue = Promise.resolve();
let counter = 0;

function loadMermaid() {
	loading ??= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "/vendor/mermaid.min.js";
		script.onload = () => {
			window.mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				suppressErrorRendering: true,
				theme: "base",
				fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
				flowchart: { htmlLabels: false, curve: "basis" },
				themeVariables: {
					darkMode: true,
					background: "#1e222a",
					primaryColor: "#252a33",
					primaryBorderColor: "#3a414e",
					primaryTextColor: "#e9ecf1",
					secondaryColor: "#1f3a68",
					secondaryBorderColor: "#6ea6ff",
					secondaryTextColor: "#e9ecf1",
					tertiaryColor: "#171a20",
					tertiaryBorderColor: "#2c323d",
					tertiaryTextColor: "#aab2c0",
					lineColor: "#7d8696",
					textColor: "#e9ecf1",
					mainBkg: "#252a33",
					nodeBorder: "#3a414e",
					edgeLabelBackground: "#1e222a",
					actorBkg: "#252a33",
					actorBorder: "#6ea6ff",
					actorTextColor: "#e9ecf1",
					signalColor: "#aab2c0",
					signalTextColor: "#e9ecf1",
					noteBkgColor: "#3d3320",
					noteBorderColor: "#f0a43a",
					noteTextColor: "#f6c27a",
				},
			});
			resolve(window.mermaid);
		};
		script.onerror = () => reject(new Error("could not load the diagram renderer"));
		document.head.append(script);
	});
	return loading;
}

function renderMermaid(source) {
	const job = queue.then(async () => {
		const mermaid = await loadMermaid();
		const { svg } = await mermaid.render(`mmd-${++counter}`, source);
		return svg;
	});
	queue = job.catch(() => {});
	return job;
}

export function MermaidView({ source, fallback, class: cls = "" }) {
	const ref = useRef();
	const [failure, setFailure] = useState(null);
	useEffect(() => {
		let alive = true;
		setFailure(null);
		const show = (svg) => {
			if (alive && ref.current) ref.current.innerHTML = svg;
		};
		renderMermaid(source)
			.then(show)
			.catch(async (error) => {
				if (fallback && fallback !== source) {
					const svg = await renderMermaid(fallback).catch(() => null);
					if (svg) return show(svg);
				}
				if (alive) setFailure(error.message);
			});
		return () => {
			alive = false;
		};
	}, [source, fallback]);
	if (failure) {
		return html`<div class="mermaid-failed">
			<div class="small warn-text">This diagram could not be drawn: ${failure.split("\n")[0]}</div>
			<pre class="mono tiny">${source}</pre>
		</div>`;
	}
	return html`<div ref=${ref} class=${`mermaid-view ${cls}`} role="img" aria-label="Diagram"></div>`;
}

function readOpen() {
	try {
		return localStorage.getItem("pi-hub-explain-open") !== "0";
	} catch {
		return true;
	}
}

function saveOpen(value) {
	try {
		localStorage.setItem("pi-hub-explain-open", value ? "1" : "0");
	} catch {}
}

export function ExplainPanel({ kind, item, revision }) {
	const state = useStore();
	const [open, setOpen] = useState(readOpen);
	const [expanded, setExpanded] = useState(false);
	const [asking, setAsking] = useState(false);
	const explain = item?.explain;
	const auto = state.config?.review?.explainDiagrams !== false;
	const toggleOpen = () => {
		setOpen(!open);
		saveOpen(!open);
	};
	const draw = async () => {
		setAsking(true);
		try {
			await api("POST", `/api/${kind}/${encodeURIComponent(item.id)}/explain`, {});
			if (!open) toggleOpen();
		} catch (error) {
			toast({ kind: "error", tone: "bad", title: "Could not draw the diagram", body: error.message });
		} finally {
			setAsking(false);
		}
	};
	const setAuto = (value) => api("PUT", "/api/config", { review: { explainDiagrams: value } }).catch((error) => toast({ kind: "error", tone: "bad", title: "Could not save", body: error.message }));
	const stale = Boolean(explain?.revision && revision && explain.revision !== revision);
	const drawing = explain?.status === "drawing";
	return html`<section class="explain-panel" aria-label="How this change works">
		<div class="explain-head">
			<button class="explain-toggle" aria-expanded=${open} onClick=${toggleOpen}><span>${open ? "▾" : "▸"}</span><span class="why-label">How it works</span></button>
			${explain?.title ? html`<span class="small ellipsis explain-title" title=${explain.title}>${explain.title}</span>` : null}
			${drawing ? html`<span class="pill accent">${explain.mermaid ? "agent is refining…" : "agent is drawing…"}</span>` : null}
			${explain?.status === "ready" ? html`<span class="pill" title=${explain.source === "agent" ? "Drawn by the agent with its model" : "Built directly from the code, without a model"}>${explain.source === "agent" ? "by the agent" : "from the code"}</span>` : null}
			${stale ? html`<span class="pill warn">drawn for v${explain.revision}</span>` : null}
			<span class="spacer"></span>
			<span title="Draw a diagram automatically when a change is complex"><${Switch} on=${auto} onChange=${setAuto} label="Auto-draw" /></span>
			<button class="btn sm" disabled=${asking || drawing} onClick=${draw}>${explain ? "Redraw" : "Draw diagram"}</button>
			${explain?.mermaid ? html`<button class="btn sm ghost" onClick=${() => setExpanded(true)}>Expand</button>` : null}
		</div>
		${open && explain
			? html`<div class="explain-body">
					${explain.summary ? html`<div class="small muted">${explain.summary}</div>` : null}
					${explain.error ? html`<div class="tiny warn-text">${explain.error}</div>` : null}
					${explain.mermaid ? html`<div class="explain-canvas"><${MermaidView} source=${explain.mermaid} fallback=${explain.fallback} /></div>` : null}
				</div>`
			: null}
		${expanded
			? html`<${Modal} width=${1200} onClose=${() => setExpanded(false)}>
					<h2 style="margin-bottom:6px">${explain.title ?? "How it works"}</h2>
					${explain.summary ? html`<div class="small muted" style="margin-bottom:12px">${explain.summary}</div>` : null}
					<div class="explain-full"><${MermaidView} source=${explain.mermaid} fallback=${explain.fallback} /></div>
				<//>`
			: null}
	</section>`;
}
