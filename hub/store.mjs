import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { STATE_FILE, ensureHubDir } from "./config.mjs";

export const COLLECTIONS = ["sessions", "reviews", "changesets", "inbox", "tasks", "testRuns", "prs", "results", "messages"];

const LIMITS = {
	reviews: 300,
	changesets: 200,
	inbox: 500,
	testRuns: 200,
	results: 300,
	messages: 1000,
};
const EVENTS_PER_SESSION = 400;
const REVIEWS_WITH_CONTENT = 80;
const SETTLED = new Set(["approved", "denied", "cancelled"]);
const BLOCKING_INBOX = new Set(["review", "question"]);

export function newId(prefix) {
	return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export class Store {
	constructor(file = STATE_FILE) {
		this.file = file;
		this.listeners = new Set();
		this.data = Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()]));
		this.events = new Map();
		this.baselines = new Map();
		this.saveTimer = null;
		this.load();
	}

	load() {
		if (!this.file || !existsSync(this.file)) return;
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8"));
			for (const name of COLLECTIONS) {
				for (const item of raw[name] ?? []) this.data[name].set(item.id, item);
			}
			for (const [sessionId, events] of Object.entries(raw.events ?? {})) this.events.set(sessionId, events);
			for (const [sessionId, files] of Object.entries(raw.baselines ?? {})) this.baselines.set(sessionId, new Map(Object.entries(files)));
		} catch (error) {
			console.error(`state load failed: ${error.message}`);
		}
	}

	snapshot() {
		const out = {};
		for (const name of COLLECTIONS) out[name] = [...this.data[name].values()];
		return out;
	}

	persist() {
		if (!this.file) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.flush(), 400);
	}

	flush() {
		if (!this.file) return;
		clearTimeout(this.saveTimer);
		ensureHubDir();
		const payload = {
			...this.snapshot(),
			events: Object.fromEntries(this.events),
			baselines: Object.fromEntries([...this.baselines].map(([id, files]) => [id, Object.fromEntries(files)])),
		};
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload));
		renameSync(tmp, this.file);
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(message) {
		for (const listener of this.listeners) listener(message);
	}

	all(name) {
		return [...this.data[name].values()];
	}

	get(name, id) {
		return this.data[name].get(id);
	}

	upsert(name, item) {
		const previous = this.data[name].get(item.id);
		const next = { ...previous, ...item, updatedAt: Date.now() };
		this.data[name].set(next.id, next);
		this.trim(name);
		this.emit({ t: "upsert", coll: name, item: publicView(name, next) });
		this.persist();
		return next;
	}

	patch(name, id, fields) {
		if (!this.data[name].has(id)) return undefined;
		return this.upsert(name, { id, ...fields });
	}

	remove(name, id) {
		if (!this.data[name].delete(id)) return;
		this.emit({ t: "remove", coll: name, id });
		this.persist();
	}

	trim(name) {
		const limit = LIMITS[name];
		if (!limit) return;
		const map = this.data[name];
		if (name === "reviews") {
			const settled = [...map.values()].filter((r) => SETTLED.has(r.status)).sort((a, b) => b.createdAt - a.createdAt);
			for (const review of settled.slice(REVIEWS_WITH_CONTENT)) {
				if (review.revisions?.length) {
					review.revisions = review.revisions.map(({ content, ...rest }) => rest);
					review.oldContent = undefined;
					review.contentDropped = true;
				}
			}
		}
		if (map.size <= limit) return;
		const removable = [...map.values()]
			.filter((item) => (name === "reviews" ? SETTLED.has(item.status) : name === "changesets" ? item.status !== "open" : item.status !== "running") && !(name === "inbox" && !item.resolved && BLOCKING_INBOX.has(item.kind)))
			.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
		for (const item of removable.slice(0, map.size - limit)) map.delete(item.id);
	}

	appendEvent(sessionId, event) {
		const list = this.events.get(sessionId) ?? [];
		const entry = { id: newId("ev"), at: Date.now(), ...event };
		list.push(entry);
		if (list.length > EVENTS_PER_SESSION) list.splice(0, list.length - EVENTS_PER_SESSION);
		this.events.set(sessionId, list);
		this.emit({ t: "event", sessionId, event: entry });
		this.persist();
		return entry;
	}

	sessionEvents(sessionId, limit = 200) {
		return (this.events.get(sessionId) ?? []).slice(-limit);
	}

	recordBaseline(sessionId, absPath, content) {
		const files = this.baselines.get(sessionId) ?? new Map();
		if (!files.has(absPath)) files.set(absPath, content);
		this.baselines.set(sessionId, files);
		this.persist();
	}

	sessionBaselines(sessionId) {
		return this.baselines.get(sessionId) ?? new Map();
	}

	forgetSession(sessionId) {
		this.events.delete(sessionId);
		this.baselines.delete(sessionId);
		this.remove("sessions", sessionId);
	}
}

export function publicView(name, item) {
	if (name === "changesets") return { ...item, files: item.files?.map(({ before, after, ...rest }) => rest) };
	if (name !== "reviews") return item;
	return {
		...item,
		oldContent: undefined,
		revisions: item.revisions?.map(({ content, ...rest }) => rest),
	};
}
