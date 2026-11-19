import { Component, html, useLayoutEffect, useRef } from "../vendor/preact-htm.js";
import { clamp, damp, edgeRates, formatNumber, sameFormat, splitNumber } from "./lerp.js";

export const RATE = { snap: 30, quick: 20, smooth: 13, soft: 8, drift: 5 };

const REST = { x: 0, y: 0, mx: 0, my: 0, lift: 0, s: 1, sx: 1, sy: 1, press: 1, o: 1 };
const EPSILON = { x: 0.1, y: 0.1, mx: 0.05, my: 0.05, lift: 0.05, s: 0.001, sx: 0.002, sy: 0.002, press: 0.001, o: 0.006 };

const FLOW = ".list-row,.inbox-item,.agent-card,.pr-card,.task-card,.chip,.toast,.queue-group,.legend-chip,.graph-note,.repo-row,.test-group,.section-title,.workspace,.review-top > *,.why-block,.explain-panel,.review-body,.changes-file,.bubble.system,.stat,.line-comment";
const LEAVING = ".toast,.modal-backdrop,.inbox-item,.list-row,.task-card,.agent-card,.pr-card,.chip,.graph-note,.repo-row,.comment-chip,.next-ready,.graph-results,.task-flash";
const SIZED = ".explain-panel,.why-block,.test-group,.changes-file,.modal";
const TRACKED = `${FLOW},${LEAVING},${SIZED},[data-m]`;
const ARRIVING = ".toast,.modal-backdrop,.msg,.bubble.system,.list-row,.queue-group,.inbox-item,.agent-card,.pr-card,.task-card,.card,.chip,.pill,.status,.legend-chip,.tl-item,.line-comment,.draft-box,.step,.test-leaf,.stat,.graph-node,.task-flash,.conflict-banner,.inspector-body,.graph-note,.repo-row,.connection,.empty,.kanban-empty,.changes-file,.main > .page > *";
const FLOURISH = "table.diff,.diffstat .boxes,.trend-chart,.graph-results";
const PINGED = ".status,.review-badge,.pill,.led,.nav-badge,.check-mark,.test-mark,.step";
const CONTROL = ".btn,.chip,.nav-item,.list-row,.legend-chip,.send-btn,.connection,.graph-result,.pill-btn,.explain-toggle,.segmented button,.switch,.gap-btns button,.block-toggle,.changes-head,.test-group-head,.gnode";
const SURFACE = ".card:not(.diff-card,.graph-card,.modal,.negotiate,.graph-inspector,.toast),.stat,.well";
const LIFTED = ".inbox-item,.agent-card,.pr-card,.task-card,.stat";
const MAGNETIC = ".btn.primary,.btn.ok,.btn.bad,.send-btn";
const PAGE_BLOCKS = ":scope > :not(.grid,.col,.kanban,.review-body,.split,.workspace),:scope > .grid > *,:scope > .col > *,:scope > .kanban > *,:scope > .review-body > *,:scope > .split > *,:scope > .workspace > :not(.grid),:scope > .workspace > .grid > *";
const GLIDERS = [
	[".rail", ":scope > .nav-item.active", "g"],
	[".rail", ":scope > .rail-pending.active", "q"],
	[".segmented:not([data-free])", ":scope > button.on", "g"],
];
const SECTIONS = ["inbox", "reviews", "agents", "tests", "tasks", "prs", "results", "graph", "settings"];
const SECTION_OF = { review: "reviews", changeset: "reviews" };

const tracks = new Map();
const poses = new WeakMap();
const dirty = new Set();
const jobs = new Set();
const textState = new WeakMap();
const gliderState = new WeakMap();
const toggleState = new WeakMap();
const scrollState = new WeakMap();
const flourished = new WeakSet();
const calm = matchMedia("(prefers-reduced-motion: reduce)");

let frame = 0;
let last = 0;
let stepping = false;
let snapshot = null;
let skipUntil = 0;
let appRoot = null;
let layer = null;
let currentPage = null;
let lastRoute = null;
let lastPoint = { x: innerWidth / 2, y: innerHeight / 2, at: 0 };
let verdict = null;
let calmUntil = 0;
let hovered = { control: null, surface: null };
let revealer = null;

export function still() {
	return calm.matches || document.hidden;
}

function wake() {
	if (frame) return;
	last = last && performance.now() - last < 100 ? last : performance.now() - 16;
	frame = requestAnimationFrame(step);
}

function flush() {
	for (const el of dirty) {
		const p = poses.get(el);
		const x = p.x + p.mx;
		const y = p.y + p.my + p.lift;
		const scale = p.s * p.press;
		const sx = scale * p.sx;
		const sy = scale * p.sy;
		el.style.translate = Math.abs(x) < 0.05 && Math.abs(y) < 0.05 ? "" : `${x.toFixed(2)}px ${y.toFixed(2)}px`;
		el.style.scale = Math.abs(sx - 1) < 0.0005 && Math.abs(sy - 1) < 0.0005 ? "" : `${sx.toFixed(4)} ${sy.toFixed(4)}`;
		el.style.opacity = p.o >= 0.999 ? "" : (p.o * p.base).toFixed(3);
	}
	dirty.clear();
}

function runJobs() {
	const pending = [...jobs];
	jobs.clear();
	for (const job of pending) job();
}

function step(now) {
	frame = 0;
	stepping = true;
	const dt = clamp((now - last) / 1000, 0.001, 0.05);
	last = now;
	for (const [owner, group] of tracks) {
		if (owner.nodeType && !owner.isConnected) {
			tracks.delete(owner);
			continue;
		}
		for (const [key, track] of group) {
			if (track.wait > 0) {
				track.wait -= dt;
				continue;
			}
			track.value = damp(track.value, track.to, track.rate, dt);
			const settled = Math.abs(track.to - track.value) < track.eps;
			if (settled) track.value = track.to;
			try {
				track.write?.(track.value);
			} catch {
				group.delete(key);
				continue;
			}
			if (settled) {
				group.delete(key);
				track.done?.();
			}
		}
		if (!group.size) tracks.delete(owner);
	}
	flush();
	runJobs();
	stepping = false;
	if (tracks.size) wake();
}

export function afterFrame(job) {
	if (stepping) jobs.add(job);
	else job();
}

export function isMoving(owner, key) {
	return Boolean(tracks.get(owner)?.has(key));
}

export function halt(owner, key) {
	const group = tracks.get(owner);
	group?.delete(key);
	if (group && !group.size) tracks.delete(owner);
}

export function tween(owner, key, to, options = {}) {
	const group = tracks.get(owner);
	const running = group?.get(key);
	const value = options.from ?? running?.value ?? to;
	const write = options.write ?? running?.write;
	if (still()) {
		halt(owner, key);
		write?.(to);
		options.done?.();
		return;
	}
	const target = group ?? new Map();
	target.set(key, { value, to, write, rate: options.rate ?? RATE.smooth, eps: options.eps ?? 0.01, wait: options.wait ?? 0, done: options.done });
	if (!group) tracks.set(owner, target);
	write?.(value);
	wake();
}

function poseOf(el) {
	let pose = poses.get(el);
	if (!pose) {
		pose = { ...REST, base: 1 };
		poses.set(el, pose);
	}
	return pose;
}

export function move(el, key, to, options = {}) {
	const pose = poseOf(el);
	tween(el, key, to, {
		...options,
		from: options.from ?? (isMoving(el, key) ? undefined : pose[key]),
		eps: options.eps ?? EPSILON[key],
		write: (value) => {
			pose[key] = value;
			dirty.add(el);
		},
	});
}

export function setVar(el, name, to, options = {}) {
	const unit = options.unit ?? "";
	const current = Number.parseFloat(el.style.getPropertyValue(name));
	const from = options.from ?? (isMoving(el, name) ? undefined : Number.isFinite(current) ? current : options.initial);
	tween(el, name, to, { ...options, from, eps: options.eps ?? 0.004, write: (value) => el.style.setProperty(name, `${Number(value.toFixed(3))}${unit}`) });
}

export function appear(el, { x = 0, y = 0, s = 1, sy = 1, wait = 0, rate = RATE.smooth } = {}) {
	if (still()) return;
	const pose = poseOf(el);
	if (pose.o === 1 && !isMoving(el, "o")) pose.base = Number(getComputedStyle(el).opacity) || 1;
	move(el, "o", 1, { from: 0, rate, wait });
	if (x) move(el, "x", 0, { from: x, rate, wait });
	if (y) move(el, "y", 0, { from: y, rate, wait });
	if (s !== 1) move(el, "s", 1, { from: s, rate, wait });
	if (sy !== 1) move(el, "sy", 1, { from: sy, rate, wait });
}

export function ping(el, amount = 1.1) {
	move(el, "s", 1, { from: amount, rate: RATE.quick });
}

function revealLater(el, options) {
	revealer ??= new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			revealer.unobserve(entry.target);
			appear(entry.target, entry.target.motionReveal);
			flush();
		}
	});
	el.motionReveal = options;
	revealer.observe(el);
}

function appearInView(el, options) {
	if (el.getBoundingClientRect().top > innerHeight) revealLater(el, { ...options, wait: 0 });
	else appear(el, options);
}

function arrival(el) {
	if (el.matches(".toast")) return el.matches(".local") ? { y: 16, s: 0.97, rate: RATE.quick } : { x: 30, s: 0.98, rate: RATE.quick };
	if (el.matches(".msg")) {
		el.style.transformOrigin = el.matches(".user") ? "100% 100%" : "0 100%";
		return { y: 8, s: 0.92, rate: RATE.quick };
	}
	if (el.matches(".rail-pending")) return { x: -16, rate: RATE.quick };
	if (el.matches(".list-row,.queue-group,.connection,.repo-row")) return { y: 6, rate: RATE.quick };
	if (el.matches(".chip,.pill,.status,.legend-chip")) return { s: el.matches(".next-ready") ? 0.55 : 0.8, rate: RATE.quick };
	if (el.matches(".tl-item,.test-leaf,.step")) return { x: -10, rate: RATE.quick };
	if (el.matches(".line-comment,.draft-box,.task-flash,.conflict-banner")) return { y: -8, rate: RATE.quick };
	if (el.matches(".inspector-body")) return { x: 12, rate: RATE.quick };
	if (el.matches(".stat")) return { y: 6, s: 0.97 };
	return { y: 10, s: 0.985 };
}

function openModal(backdrop) {
	appear(backdrop, { rate: RATE.quick });
	const modal = backdrop.querySelector(".modal");
	if (!modal) return;
	const box = modal.getBoundingClientRect();
	if (performance.now() - lastPoint.at < 600) modal.style.transformOrigin = `${clamp(lastPoint.x - box.left, 0, box.width)}px ${clamp(lastPoint.y - box.top, 0, box.height)}px`;
	appear(modal, { y: 10, s: 0.93, rate: RATE.quick });
}

function sweepDiff(table) {
	const rows = [...table.querySelectorAll("tr[data-block],tr.block-head")].slice(0, 70);
	rows.forEach((row, index) => appear(row, { wait: 0.05 + Math.min(index * 0.008, 0.3), rate: RATE.quick }));
}

function growBars(chart) {
	[...chart.querySelectorAll(".trend-bar rect[fill^='var']")].slice(-60).forEach((bar, index) => appear(bar, { sy: 0.01, wait: index * 0.012 }));
}

function flourish(root) {
	if (!root.querySelectorAll) return;
	const found = [...root.querySelectorAll(FLOURISH)];
	if (root.matches?.(FLOURISH)) found.push(root);
	for (const el of found) {
		if (flourished.has(el)) continue;
		flourished.add(el);
		if (el.matches("table.diff")) sweepDiff(el);
		else if (el.matches(".trend-chart")) growBars(el);
		else [...el.children].forEach((child, index) => appear(child, { s: el.matches(".boxes") ? 0.2 : 0.97, y: el.matches(".boxes") ? 0 : -4, wait: index * 0.028, rate: RATE.quick }));
	}
}

function routeOf() {
	const parts = (location.hash || "#/inbox").replace(/^#\/?/, "").split("/");
	const name = parts[0] || "inbox";
	return { section: SECTIONS.indexOf(SECTION_OF[name] ?? name), detail: Boolean(parts[1]), hash: location.hash };
}

function enterPage(page) {
	const route = routeOf();
	const previous = lastRoute;
	lastRoute = route;
	const fresh = Boolean(verdict);
	const direction = previous ? Math.sign(route.section - previous.section) : 0;
	const drill = previous && route.section === previous.section && route.detail && !previous.detail;
	const distance = fresh ? 30 : direction ? direction * 16 : 8;
	calmUntil = performance.now() + 700;
	if (page.scrollHeight <= page.clientHeight + 1) {
		page.style.overflow = "hidden";
		setTimeout(() => (page.style.overflow = ""), 800);
	}
	if (drill && performance.now() - lastPoint.at < 900) {
		const box = page.getBoundingClientRect();
		page.style.transformOrigin = `${lastPoint.x - box.left}px ${lastPoint.y - box.top}px`;
		move(page, "s", 1, { from: 0.975, rate: RATE.smooth });
	}
	[...page.querySelectorAll(PAGE_BLOCKS)].slice(0, 22).forEach((block, index) => appearInView(block, { y: distance, wait: Math.min(index * 0.026, 0.26) }));
	flourish(page);
	verdict = null;
}

function capture() {
	if (snapshot || !appRoot || still() || performance.now() < skipUntil) return;
	const started = performance.now();
	const rects = new Map();
	const keys = new Map();
	for (const el of [...appRoot.querySelectorAll(TRACKED)].slice(0, 320)) {
		const rect = el.getBoundingClientRect();
		rects.set(el, rect);
		if (el.dataset.m) keys.set(el.dataset.m, rect);
	}
	snapshot = { rects, keys, page: currentPage, clones: new Map(), outer: new Map(), inPage: new Set() };
	if (performance.now() - started > 8) skipUntil = performance.now() + 250;
	const taken = snapshot;
	setTimeout(() => {
		if (snapshot === taken) snapshot = null;
	}, 0);
}

export const beforeChange = capture;

function preserve(node) {
	const before = snapshot;
	const start = node.nodeType === 1 ? node : node.parentElement;
	if (!before || !start?.isConnected || !appRoot.contains(start)) return;
	const inPage = before.page?.contains(start);
	let inner = null;
	for (let host = start.closest(LEAVING); host; host = host.parentElement?.closest(LEAVING)) {
		if (inner) before.outer.set(inner, host);
		inner = host;
		if (inPage) before.inPage.add(host);
		if (before.rects.has(host) && !before.clones.has(host) && before.clones.size < 20) before.clones.set(host, host.cloneNode(true));
	}
}

function resize(before) {
	const changes = [];
	for (const el of appRoot.querySelectorAll(SIZED)) {
		const old = before.rects.get(el);
		if (!old) continue;
		const inline = el.style.height;
		if (inline) el.style.height = "";
		const height = el.offsetHeight;
		if (inline) el.style.height = inline;
		if (Math.abs(old.height - height) > 1) changes.push({ el, from: old.height, to: height });
	}
	for (const { el, from, to } of changes) {
		el.style.overflow = "hidden";
		tween(el, "height", to, {
			from,
			rate: RATE.smooth,
			eps: 0.4,
			write: (value) => (el.style.height = `${value.toFixed(1)}px`),
			done: () => {
				el.style.height = "";
				el.style.overflow = "";
			},
		});
	}
}

function reflow(before) {
	const applied = new Map();
	for (const el of [...appRoot.querySelectorAll(`${FLOW},[data-m]`)].slice(0, 320)) {
		if (performance.now() < calmUntil && currentPage?.contains(el)) continue;
		const keyed = !before.rects.has(el) && el.dataset.m ? before.keys.get(el.dataset.m) : null;
		const old = before.rects.get(el) ?? keyed;
		if (!old) continue;
		const pose = poseOf(el);
		const now = el.getBoundingClientRect();
		const parent = el.parentElement?.closest(FLOW);
		const carried = (parent && applied.get(parent)) || [0, 0];
		const dx = old.left - (now.left - pose.x - pose.mx) - carried[0];
		const dy = old.top - (now.top - pose.y - pose.my - pose.lift) - carried[1];
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		if (Math.abs(dy) > innerHeight * 1.2 || Math.abs(dx) > innerWidth) continue;
		if (Math.abs(dx - pose.x) < 0.5 && Math.abs(dy - pose.y) < 0.5) continue;
		applied.set(el, [dx, dy]);
		if (keyed) {
			el.motionLanded = true;
			el.style.zIndex = "5";
		}
		move(el, "x", 0, { from: dx, rate: RATE.smooth });
		move(el, "y", 0, { from: dy, rate: RATE.smooth, done: keyed ? () => (el.style.zIndex = "") : undefined });
	}
}

function welcome(records, before, pageChanged) {
	const targets = [];
	const seen = new Set();
	for (const record of records) {
		for (const node of record.addedNodes) {
			if (node.nodeType !== 1 || !node.isConnected) continue;
			if (pageChanged && currentPage?.contains(node)) continue;
			flourish(node);
			const found = node.matches(ARRIVING) ? [node] : [...node.querySelectorAll(ARRIVING)];
			for (const el of found.slice(0, 40)) if (!seen.has(el)) (seen.add(el), targets.push(el));
		}
	}
	const siblings = new Map();
	for (const el of targets.slice(0, 80)) {
		if (el.motionLanded) continue;
		if (el.parentElement?.closest(ARRIVING) && seen.has(el.parentElement.closest(ARRIVING))) continue;
		if (el.dataset.m && before.keys.has(el.dataset.m)) continue;
		if (el.matches(".modal-backdrop")) {
			openModal(el);
			continue;
		}
		const index = siblings.get(el.parentElement) ?? 0;
		siblings.set(el.parentElement, index + 1);
		appearInView(el, { ...arrival(el), wait: Math.min(index * 0.028, 0.2) });
	}
}

function layerEl() {
	if (!layer) {
		layer = document.createElement("div");
		layer.className = "motion-layer";
		layer.setAttribute("aria-hidden", "true");
		document.body.append(layer);
	}
	return layer;
}

function ghost(clone, rect, { x = 0, y = 0, s = 0.96, rate = RATE.quick, scroll = 0 } = {}) {
	if (!rect?.width || rect.bottom < 0 || rect.top > innerHeight) return;
	clone.removeAttribute("id");
	for (const item of clone.querySelectorAll("[id]")) item.removeAttribute("id");
	clone.setAttribute("tabindex", "-1");
	Object.assign(clone.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, right: "auto", bottom: "auto", width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", translate: "", scale: "", opacity: "" });
	layerEl().append(clone);
	const inner = clone.querySelector(".diff-scroll");
	if (inner) inner.scrollTop = scroll;
	move(clone, "o", 0, { from: 1, rate, eps: 0.02, done: () => clone.remove() });
	if (x) move(clone, "x", x, { from: 0, rate });
	if (y) move(clone, "y", y, { from: 0, rate });
	if (s !== 1) move(clone, "s", s, { from: 1, rate });
}

function departure(el) {
	if (el.matches(".toast")) return el.matches(".local") ? { y: 12 } : { x: 34 };
	if (el.matches(".rail-pending")) return { x: -18 };
	if (el.matches(".inbox-item,.list-row")) return { x: 26, s: 0.985 };
	if (el.matches(".modal-backdrop")) return { s: 1 };
	if (el.matches(".graph-results")) return { y: -4, s: 1 };
	return {};
}

function dismiss(before, pageChanged) {
	if (pageChanged && verdict?.clone) {
		ghost(verdict.clone, verdict.rect, { ...(verdict.kind === "approved" ? { y: -34 } : { x: -44 }), s: 0.985, rate: RATE.smooth, scroll: verdict.scroll });
		verdict.clone = null;
	}
	const alive = new Set([...appRoot.querySelectorAll("[data-m]")].map((el) => el.dataset.m));
	let count = 0;
	for (const [el, clone] of before.clones) {
		if (el.isConnected || count >= 12 || (pageChanged && before.inPage.has(el))) continue;
		const outer = before.outer.get(el);
		if (outer && !outer.isConnected) continue;
		if (el.dataset.m && alive.has(el.dataset.m)) continue;
		ghost(clone, before.rects.get(el), departure(el));
		count++;
	}
}

function react(records) {
	for (const record of records) {
		if (record.type !== "attributes" || !record.target.isConnected) continue;
		const el = record.target;
		const old = record.oldValue ?? "";
		if (old === el.className.baseVal || old === el.className) continue;
		if (el.matches(".review-badge") && /pending|thinking/.test(old)) {
			const kind = el.classList.contains("approved") ? "approved" : el.classList.contains("denied") ? "denied" : null;
			if (kind) {
				verdict = { kind };
				const card = appRoot.querySelector(".diff-card");
				if (card) {
					card.dataset.verdict = kind;
					setVar(card, "--flash", 0, { from: 0.2, rate: RATE.drift });
					verdict.rect = card.getBoundingClientRect();
					verdict.scroll = card.querySelector(".diff-scroll")?.scrollTop ?? 0;
					if (card.getElementsByTagName("*").length <= 5000) verdict.clone = card.cloneNode(true);
				}
			}
		}
		if (el.matches(PINGED)) ping(el);
	}
}

function syncGliders() {
	for (const [hostSelector, childSelector, name] of GLIDERS) {
		for (const host of appRoot.querySelectorAll(hostSelector)) {
			const child = host.querySelector(childSelector);
			const states = gliderState.get(host) ?? {};
			gliderState.set(host, states);
			const state = states[name];
			const alpha = `--${name}a`;
			if (!child || !child.offsetWidth) {
				if (state?.box) {
					setVar(host, alpha, 0, { rate: RATE.quick });
					state.box = null;
				}
				continue;
			}
			const box = { l: child.offsetLeft, t: child.offsetTop, r: child.offsetLeft + child.offsetWidth, b: child.offsetTop + child.offsetHeight };
			if (state?.box && ["l", "t", "r", "b"].every((edge) => state.box[edge] === box[edge])) continue;
			const horizontal = edgeRates(box.l - (state?.box?.l ?? box.l));
			const vertical = edgeRates(box.t - (state?.box?.t ?? box.t));
			const rates = { l: horizontal.start, r: horizontal.end, t: vertical.start, b: vertical.end };
			for (const edge of ["l", "t", "r", "b"]) {
				const prop = `--${name}${edge}`;
				if (state?.box) setVar(host, prop, box[edge], { rate: rates[edge], eps: 0.1 });
				else {
					halt(host, prop);
					host.style.setProperty(prop, box[edge]);
				}
			}
			setVar(host, alpha, 1, { rate: RATE.quick, initial: 0 });
			states[name] = { box };
		}
	}
}

function syncToggles() {
	for (const el of appRoot.querySelectorAll(".switch,.chev")) {
		const on = el.classList.contains("on") || el.classList.contains("open") ? 1 : 0;
		if (toggleState.get(el) === on) continue;
		const known = toggleState.has(el);
		toggleState.set(el, on);
		if (known) setVar(el, "--on", on, { rate: RATE.quick });
		else el.style.setProperty("--on", on);
	}
}

function introShell() {
	appear(appRoot.querySelector(".topbar"), { y: -12 });
	appear(appRoot.querySelector(".rail"), { x: -14 });
	[...appRoot.querySelectorAll(".rail > .nav-item")].forEach((item, index) => appear(item, { x: -10, wait: 0.04 + index * 0.024, rate: RATE.quick }));
}

function play(records) {
	const before = snapshot;
	snapshot = null;
	const page = appRoot.querySelector(".main > .page");
	const pageChanged = page !== currentPage;
	const firstPaint = pageChanged && !currentPage && !lastRoute;
	const previousPage = currentPage;
	currentPage = page;
	syncToggles();
	syncGliders();
	if (still()) {
		if (pageChanged) lastRoute = routeOf();
		flush();
		return;
	}
	if (firstPaint && appRoot.querySelector(".topbar")) introShell();
	if (before) {
		before.page = previousPage;
		resize(before);
		reflow(before);
		react(records);
		dismiss(before, pageChanged);
		welcome(records, before, pageChanged);
	}
	if (pageChanged && page) enterPage(page);
	flush();
}

function refreshPointer(slot, el, event) {
	if (!el) return;
	const box = el.getBoundingClientRect();
	const x = event.clientX - box.left;
	const y = event.clientY - box.top;
	const previous = hovered[slot] === el ? el.motionPointer : null;
	el.motionPointer = { x, y };
	setVar(el, "--lx", x, { unit: "px", rate: RATE.snap, eps: 0.5, from: isMoving(el, "--lx") ? undefined : (previous?.x ?? x) });
	setVar(el, "--ly", y, { unit: "px", rate: RATE.snap, eps: 0.5, from: isMoving(el, "--ly") ? undefined : (previous?.y ?? y) });
	if (el.matches(MAGNETIC)) {
		move(el, "mx", clamp((x - box.width / 2) * 0.1, -3, 3), { rate: RATE.quick });
		move(el, "my", clamp((y - box.height / 2) * 0.16, -2, 2), { rate: RATE.quick });
	}
}

function hoverIn(el) {
	setVar(el, "--h", 1, { rate: RATE.quick, initial: 0 });
	setVar(el, "--hi", 1, { rate: RATE.quick, initial: 0 });
	if (el.matches(LIFTED)) move(el, "lift", -2, { rate: RATE.quick });
	else if (el.matches(".btn:not(:disabled),.send-btn:not(:disabled)")) move(el, "lift", -1, { rate: RATE.quick });
	else if (el.matches(".list-row")) move(el, "mx", 2, { rate: RATE.quick });
	else if (el.matches(".gnode")) move(el, "s", 1.04, { rate: RATE.quick });
}

function hoverOut(el) {
	setVar(el, "--h", 0, { rate: RATE.soft });
	setVar(el, "--hi", 0, { rate: RATE.soft });
	if (el.matches(LIFTED) || el.matches(".btn,.send-btn")) move(el, "lift", 0, { rate: RATE.soft });
	if (el.matches(".list-row") || el.matches(MAGNETIC)) move(el, "mx", 0, { rate: RATE.soft });
	if (el.matches(MAGNETIC)) move(el, "my", 0, { rate: RATE.soft });
	if (el.matches(".gnode")) move(el, "s", 1, { rate: RATE.soft });
}

function onPointerMove(event) {
	if (event.pointerType !== "mouse" || still() || !event.target.closest) return;
	const pick = (selector) => {
		const el = event.target.closest(selector);
		return el && !el.disabled ? el : null;
	};
	for (const [slot, selector] of [["control", CONTROL], ["surface", SURFACE]]) {
		const el = pick(selector);
		refreshPointer(slot, el, event);
		if (el === hovered[slot]) continue;
		if (hovered[slot]) hoverOut(hovered[slot]);
		if (el) hoverIn(el);
		hovered[slot] = el;
	}
}

function clearHover() {
	for (const slot of ["control", "surface"]) {
		if (hovered[slot]) hoverOut(hovered[slot]);
		hovered[slot] = null;
	}
}

let pressed = null;

function release() {
	if (!pressed) return;
	move(pressed, "press", 1, { rate: RATE.quick });
	setVar(pressed, "--p", 0, { rate: RATE.soft });
	pressed = null;
}

function onPointerDown(event) {
	lastPoint = { x: event.clientX, y: event.clientY, at: performance.now() };
	const el = event.target.closest?.(CONTROL);
	if (!el || el.disabled || el.matches(".gnode")) return;
	pressed = el;
	const box = el.getBoundingClientRect();
	el.style.setProperty("--lx", `${event.clientX - box.left}px`);
	el.style.setProperty("--ly", `${event.clientY - box.top}px`);
	move(el, "press", el.matches(".nav-item,.list-row") ? 0.985 : 0.955, { rate: RATE.snap });
	setVar(el, "--p", 1, { rate: RATE.snap, initial: 0 });
}

function scrollerOf(start, delta) {
	for (let el = start; el && el !== document.body; el = el.parentElement) {
		if (el.scrollHeight <= el.clientHeight + 1) continue;
		const overflow = getComputedStyle(el).overflowY;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		const room = el.scrollHeight - el.clientHeight;
		const goal = scrollGoal(el);
		if (!delta || (delta > 0 ? goal < room - 1 : goal > 1)) return el;
	}
	return null;
}

function scrollGoal(el) {
	return tracks.get(el)?.get("scroll")?.to ?? el.scrollTop;
}

export function glideScroll(el, top, { rate = 14, instant = false } = {}) {
	if (!el) return;
	const goal = clamp(top, 0, el.scrollHeight - el.clientHeight);
	if (instant || still()) {
		halt(el, "scroll");
		el.scrollTop = goal;
		return;
	}
	const state = scrollState.get(el) ?? {};
	scrollState.set(el, state);
	if (!isMoving(el, "scroll")) state.at = el.scrollTop;
	tween(el, "scroll", goal, {
		from: isMoving(el, "scroll") ? undefined : el.scrollTop,
		rate,
		eps: 0.6,
		write: (value) => {
			if (Math.abs(el.scrollTop - state.at) > 3) return halt(el, "scroll");
			el.scrollTop = value;
			state.at = el.scrollTop;
		},
	});
}

export function glideIntoView(el) {
	const scroller = scrollerOf(el.parentElement, 0);
	if (!scroller) return;
	const box = el.getBoundingClientRect();
	const frameBox = scroller.getBoundingClientRect();
	glideScroll(scroller, scroller.scrollTop + box.top - frameBox.top - (frameBox.height - box.height) / 2, { rate: 10 });
}

function onWheel(event) {
	if (event.defaultPrevented || event.ctrlKey || event.shiftKey || still() || !event.deltaY || event.deltaX) return;
	const notched = event.deltaMode === 1 || (event.deltaMode === 0 && Math.abs(event.deltaY) >= 50 && Number.isInteger(event.deltaY));
	if (!notched || event.target.closest?.("textarea,select,.graph-canvas,.motion-layer")) return;
	const delta = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY;
	const scroller = scrollerOf(event.target, delta);
	if (!scroller) return;
	event.preventDefault();
	glideScroll(scroller, scrollGoal(scroller) + delta);
}

export function growField(el, max = 140) {
	const from = el.offsetHeight;
	el.style.height = "auto";
	const to = Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), max);
	el.style.height = `${from}px`;
	tween(el, "height", to, { from: isMoving(el, "height") ? undefined : from, rate: RATE.quick, eps: 0.3, write: (value) => (el.style.height = `${value.toFixed(1)}px`) });
}

function setText(el, text, count) {
	const node = el.firstChild ?? el.appendChild(document.createTextNode(""));
	const state = textState.get(el);
	const next = splitNumber(text);
	if (!state) {
		textState.set(el, { text, parts: next, value: next?.value ?? 0 });
		if (count && next && next.value > 0 && !still()) {
			tween(el, "text", next.value, { from: 0, rate: RATE.soft, eps: 10 ** -next.decimals / 2, write: (value) => (node.data = formatNumber(next, value)), done: () => (node.data = text) });
		} else node.data = text;
		return;
	}
	if (state.text === text) return;
	const running = tracks.get(el)?.get("text")?.value;
	const start = running ?? state.parts?.value ?? 0;
	state.text = text;
	if (sameFormat(state.parts, next)) {
		tween(el, "text", next.value, { from: start, rate: RATE.smooth, eps: 10 ** -next.decimals / 2, write: (value) => (node.data = formatNumber(next, value)), done: () => (node.data = text) });
	} else {
		halt(el, "text");
		node.data = text;
		if (!still()) appear(el, { y: 4, rate: RATE.quick });
	}
	state.parts = next;
	if (el.isConnected && !still()) ping(el, 1.08);
	flush();
}

export function TweenText({ value, class: cls = "", count = false }) {
	const ref = useRef();
	const text = String(value ?? "");
	useLayoutEffect(() => setText(ref.current, text, count), [text]);
	return html`<span ref=${ref} class=${`tween ${cls}`}></span>`;
}

export function Meter({ value, color }) {
	const ref = useRef();
	const seen = useRef(false);
	useLayoutEffect(() => {
		setVar(ref.current, "width", value, { from: seen.current ? undefined : 0, unit: "%", rate: RATE.soft, eps: 0.05 });
		seen.current = true;
	}, [value]);
	return html`<div class="meter" style=${`--c:${color}`}><span ref=${ref}></span></div>`;
}

export function useActivity(ref, level) {
	useLayoutEffect(() => {
		if (ref.current) setVar(ref.current, "--activity", level, { rate: RATE.drift, initial: 0 });
	}, [level]);
}

export function drawLine(path, { wait = 0, rate = RATE.soft } = {}) {
	if (still() || !path.getTotalLength) return;
	path.setAttribute("pathLength", "1");
	path.style.strokeDasharray = "1";
	tween(path, "draw", 0, {
		from: 1,
		rate,
		wait,
		eps: 0.004,
		write: (value) => (path.style.strokeDashoffset = value.toFixed(3)),
		done: () => {
			path.removeAttribute("pathLength");
			path.style.strokeDasharray = "";
			path.style.strokeDashoffset = "";
		},
	});
}

export function revealDiagram(root) {
	if (still()) return;
	const shapes = [...root.querySelectorAll("g.node,g.cluster,g.edgeLabel,.actor,text.messageText,g.note,g.stateGroup,g.classGroup")].slice(0, 120);
	shapes.forEach((shape, index) => appear(shape, { wait: Math.min(index * 0.03, 0.5), rate: RATE.smooth }));
	const lines = [...root.querySelectorAll("path.flowchart-link,line.messageLine0,path.messageLine0,path.relation,path.transition")].slice(0, 80);
	lines.forEach((line, index) => {
		if (!getComputedStyle(line).strokeDasharray || getComputedStyle(line).strokeDasharray === "none") drawLine(line, { wait: 0.12 + Math.min(index * 0.03, 0.5) });
		else appear(line, { wait: 0.12 + Math.min(index * 0.03, 0.5) });
	});
	flush();
}

export function commit() {
	flush();
}

export function installMotion(root) {
	appRoot = root;
	const setState = Component.prototype.setState;
	Component.prototype.setState = function patched(...args) {
		capture();
		return setState.apply(this, args);
	};
	const removeChild = Node.prototype.removeChild;
	Node.prototype.removeChild = function patched(child) {
		if (snapshot) preserve(child);
		return removeChild.call(this, child);
	};
	new MutationObserver(play).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
	addEventListener("pointermove", onPointerMove, { passive: true });
	addEventListener("pointerdown", onPointerDown, { passive: true, capture: true });
	addEventListener("pointerup", release, { passive: true });
	addEventListener("pointercancel", release, { passive: true });
	addEventListener("wheel", onWheel, { passive: false });
	addEventListener("resize", () => syncGliders());
	document.documentElement.addEventListener("pointerleave", clearHover);
}
