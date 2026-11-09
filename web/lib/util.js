import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { sessionOf } from "./store.js";

export function timeAgo(ts) {
	if (!ts) return "";
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 10) return "now";
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

export function clock(ts) {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function duration(ms) {
	if (ms == null) return "";
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function money(value) {
	if (!value) return "$0.00";
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function compact(n) {
	if (!n) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function sessionName(session) {
	if (!session) return "unknown";
	return session.name || session.repo || session.cwd?.split(/[\\/]/).pop() || session.id;
}

export function colorOf(sessionOrId) {
	const session = typeof sessionOrId === "string" ? sessionOf(sessionOrId) : sessionOrId;
	return session?.color?.hex ?? "#ff6b1a";
}

export function useTick(ms = 15000) {
	const [, set] = useState(0);
	useEffect(() => {
		const id = setInterval(() => set((v) => v + 1), ms);
		return () => clearInterval(id);
	}, [ms]);
}

export function navigate(hash) {
	if (location.hash !== hash) location.hash = hash;
}

export function useRoute() {
	const [hash, setHash] = useState(location.hash || "#/inbox");
	useEffect(() => {
		const onChange = () => setHash(location.hash || "#/inbox");
		addEventListener("hashchange", onChange);
		return () => removeEventListener("hashchange", onChange);
	}, []);
	const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
	return { name: parts[0] || "inbox", id: parts[1], rest: parts.slice(2), hash };
}

export function Markdown({ text, class: cls = "" }) {
	const rendered = window.marked ? window.marked.parse(String(text ?? ""), { breaks: true, gfm: true }) : escapeHtml(text);
	return html`<div class=${`markdown ${cls}`} dangerouslySetInnerHTML=${{ __html: sanitize(rendered) }}></div>`;
}

export function escapeHtml(text) {
	return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function sanitize(markup) {
	const template = document.createElement("template");
	template.innerHTML = markup;
	for (const node of template.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form")) node.remove();
	for (const node of template.content.querySelectorAll("*")) {
		for (const attr of [...node.attributes]) {
			const value = attr.value.trim().toLowerCase();
			if (attr.name.startsWith("on") || ((attr.name === "href" || attr.name === "src") && value.startsWith("javascript:"))) node.removeAttribute(attr.name);
		}
		if (node.tagName === "A") {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noreferrer");
		}
	}
	return template.innerHTML;
}

export function MonoBadge({ session, large = false }) {
	const busy = session?.status === "working";
	const letter = sessionName(session).trim().charAt(0) || "?";
	return html`<span class=${`mono-badge ${large ? "lg" : ""} ${busy ? "pulse" : ""} ${session?.online === false ? "dim" : ""}`} style=${`--c:${colorOf(session)}`}>${letter}</span>`;
}

export function SessionChip({ session, id, on, onClick, showStatus = false, static: isStatic = false }) {
	const s = session ?? sessionOf(id);
	if (!s) return html`<span class="chip static offline"><span class="dot dim"></span>${id ?? "hub"}</span>`;
	return html`<button
		class=${`chip ${on ? "on" : ""} ${s.online ? "" : "offline"} ${isStatic ? "static" : ""}`}
		style=${`--c:${s.color?.hex}`}
		onClick=${onClick}
		title=${`${sessionName(s)} · ${s.color?.name ?? ""} · ${s.cwd ?? ""}`}
	>
		<${MonoBadge} session=${s} />
		${sessionName(s)} ${showStatus ? html`<span class="faint tiny">${s.status}</span>` : null}
	</button>`;
}

const ZERO_VALUES = new Set(["0", "0%", "–", "-", "$0.00", "$0.0000", "0ms", "?"]);

export function Stat({ value, label, tone }) {
	const text = String(value ?? "–");
	const zero = ZERO_VALUES.has(text);
	return html`<div class=${`stat ${zero ? "zero" : tone ? `tone-${tone}` : ""}`}><div class="stat-v">${text}</div><div class="stat-k">${label}</div></div>`;
}

export function Status({ value }) {
	return html`<span class=${`status ${value}`}>${value}</span>`;
}

export function Empty({ icon = "✦", title, children }) {
	return html`<div class="empty">
		<div class="empty-orb">${icon}</div>
		<div style="font-family:var(--font-display);font-size:17px;color:var(--ink)">${title}</div>
		<div class="small" style="margin-top:6px">${children}</div>
	</div>`;
}

export function Switch({ on, onChange, label }) {
	return html`<label class="row" style="cursor:pointer;gap:10px">
		<span class=${`switch ${on ? "on" : ""}`} onClick=${(e) => (e.preventDefault(), onChange(!on))}></span>
		${label ? html`<span class="small">${label}</span>` : null}
	</label>`;
}

export function Modal({ onClose, children, width }) {
	useEffect(() => {
		const onKey = (e) => e.key === "Escape" && onClose();
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, []);
	return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
		<div class="card glossy modal" style=${width ? `width:min(${width}px, calc(100vw - 32px))` : ""}>${children}</div>
	</div>`;
}

export function isTyping(event) {
	const el = event.target;
	return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}
