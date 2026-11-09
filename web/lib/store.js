import { useEffect, useState } from "../vendor/preact-htm.js";

const COLLECTIONS = ["sessions", "reviews", "inbox", "tasks", "testRuns", "prs", "results", "messages"];

const state = {
	connected: false,
	loaded: false,
	config: null,
	hub: null,
	version: 0,
	events: new Map(),
	...Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()])),
};

const listeners = new Set();
const inboxListeners = new Set();
let notifyTimer = null;

function changed() {
	state.version++;
	if (notifyTimer) return;
	notifyTimer = requestAnimationFrame(() => {
		notifyTimer = null;
		for (const listener of listeners) listener(state.version);
	});
}

export function getState() {
	return state;
}

export function useStore() {
	const [, setVersion] = useState(state.version);
	useEffect(() => {
		const listener = (v) => setVersion(v);
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, []);
	return state;
}

export function onInboxItem(listener) {
	inboxListeners.add(listener);
	return () => inboxListeners.delete(listener);
}

const TOKEN_KEY = "pi-hub-token";

function readStoredToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return "";
	}
}

let token = readStoredToken();

function captureToken() {
	const url = new URL(location.href);
	const fromUrl = url.searchParams.get("token");
	if (!fromUrl) return;
	token = fromUrl;
	try {
		localStorage.setItem(TOKEN_KEY, fromUrl);
	} catch {}
	url.searchParams.delete("token");
	history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export async function api(method, path, body) {
	const res = await fetch(path, {
		method,
		credentials: "omit",
		headers: { "x-hub-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
	return data;
}

async function loadSnapshot() {
	const snapshot = await api("GET", "/api/state");
	for (const name of COLLECTIONS) {
		state[name] = new Map((snapshot[name] ?? []).map((item) => [item.id, item]));
	}
	state.config = snapshot.config;
	state.hub = snapshot.hub;
	state.loaded = true;
	changed();
}

function apply(message) {
	if (message.t === "upsert") {
		const isNew = !state[message.coll].has(message.item.id);
		state[message.coll].set(message.item.id, message.item);
		if (message.coll === "inbox" && isNew && !message.item.resolved) for (const listener of inboxListeners) listener(message.item);
	} else if (message.t === "remove") {
		state[message.coll].delete(message.id);
	} else if (message.t === "config") {
		state.config = message.config;
	} else if (message.t === "event") {
		const list = state.events.get(message.sessionId);
		if (list) list.push(message.event);
	}
	changed();
}

export async function loadEvents(sessionId) {
	const { events } = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=400`);
	state.events.set(sessionId, events);
	changed();
}

export function connect() {
	captureToken();
	let source;
	let retry = 500;
	const open = async () => {
		try {
			await loadSnapshot();
		} catch (error) {
			state.connected = false;
			state.authError = /unauthorized/.test(error.message);
			changed();
			setTimeout(open, Math.min((retry *= 2), 5000));
			return;
		}
		source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
		source.onopen = () => {
			state.connected = true;
			retry = 500;
			changed();
		};
		source.onmessage = (event) => apply(JSON.parse(event.data));
		source.onerror = () => {
			state.connected = false;
			changed();
			source.close();
			setTimeout(open, Math.min((retry *= 2), 5000));
		};
	};
	open();
}

export function sessionOf(id) {
	return state.sessions.get(id);
}

export function sorted(map, key = "createdAt", desc = true) {
	return [...map.values()].sort((a, b) => (desc ? (b[key] ?? 0) - (a[key] ?? 0) : (a[key] ?? 0) - (b[key] ?? 0)));
}

export function pendingReviews() {
	return sorted(state.reviews, "createdAt", false).filter((r) => r.status === "pending" || r.status === "thinking");
}

export function openInbox() {
	return sorted(state.inbox).filter((i) => !i.resolved);
}
