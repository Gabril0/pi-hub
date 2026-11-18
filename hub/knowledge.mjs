import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { newId } from "./store.mjs";
import { canonicalRepoRoot, scanRepo } from "./knowledge-scan.mjs";
import { ROOT_ID, buildModel, describeNode, repoMarkdown, repoNodeId, resolveTarget, searchNodes, viewGraph, workspaceMarkdown } from "./knowledge-graph.mjs";
import { changeDiagram } from "./change-diagram.mjs";

const RESCAN_AFTER_MS = 10 * 60_000;
const MAX_NOTE = 4000;
const MAX_LABEL = 200;

function repoKeyOf(root, pathKey) {
	const slug = basename(String(root).replace(/[\\/]+$/, "")).toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "repo";
	return `${slug}-${createHash("sha1").update(pathKey(root)).digest("hex").slice(0, 6)}`;
}

export function createKnowledge({ store, dir, pathKey, log = () => {} }) {
	const scans = new Map();
	const timers = new Map();
	const running = new Set();
	let model;
	let docsTimer = null;
	let closed = false;

	const scanFile = (key) => join(dir, `${key}.scan.json`);

	function save(file, text) {
		mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, file);
	}

	for (const repo of store.all("repos")) {
		try {
			if (existsSync(scanFile(repo.id))) scans.set(repo.id, JSON.parse(readFileSync(scanFile(repo.id), "utf8")));
		} catch {}
		if (repo.status === "scanning") store.patch("repos", repo.id, { status: scans.has(repo.id) ? "ready" : "pending" });
	}

	function invalidate() {
		model = undefined;
		clearTimeout(docsTimer);
		docsTimer = setTimeout(writeDocs, 500);
		docsTimer.unref?.();
	}

	const unsubscribe = store.subscribe((message) => {
		if (["notes", "graphLinks"].includes(message.coll)) invalidate();
	});

	function currentModel() {
		model ??= buildModel({
			repos: store.all("repos").filter((repo) => scans.has(repo.id)).map((repo) => ({ ...scans.get(repo.id), key: repo.id, root: repo.root, name: repo.name })),
			notes: store.all("notes"),
			links: store.all("graphLinks"),
		});
		return model;
	}

	function writeDocs() {
		docsTimer = null;
		if (closed) return;
		try {
			const current = currentModel();
			for (const key of current.repos.keys()) save(join(dir, `${key}.md`), repoMarkdown(current, key));
			save(join(dir, "workspace.md"), workspaceMarkdown(current));
		} catch (error) {
			log(`knowledge docs failed: ${error.message}`);
		}
	}

	async function scan(key) {
		const repo = store.get("repos", key);
		if (!repo || closed) return;
		if (running.has(key)) {
			schedule(key, 1500);
			return;
		}
		running.add(key);
		store.patch("repos", key, { status: "scanning", error: undefined });
		try {
			if (!existsSync(repo.root) || !statSync(repo.root).isDirectory()) throw new Error("folder not found");
			const result = await scanRepo(repo.root, { isCancelled: () => closed });
			if (!result || closed) return;
			scans.set(key, result);
			save(scanFile(key), JSON.stringify(result));
			store.patch("repos", key, { status: "ready", scannedAt: result.scannedAt, files: result.files.length, truncated: result.truncated, description: result.description });
			invalidate();
		} catch (error) {
			log(`knowledge scan ${key}: ${error.message}`);
			if (!closed) store.patch("repos", key, { status: "error", error: error.message });
		} finally {
			running.delete(key);
		}
	}

	function schedule(key, delay = 3000) {
		clearTimeout(timers.get(key));
		const timer = setTimeout(() => {
			timers.delete(key);
			void scan(key);
		}, delay);
		timer.unref?.();
		timers.set(key, timer);
	}

	async function addRepo(path, source = "manual") {
		if (closed) return undefined;
		const root = await canonicalRepoRoot(path);
		if (closed) return undefined;
		const key = repoKeyOf(root, pathKey);
		const existing = store.get("repos", key);
		if (existing) {
			if (source === "manual" && existing.source !== "manual") store.patch("repos", key, { source });
			if (Date.now() - (existing.scannedAt ?? 0) > RESCAN_AFTER_MS || !scans.has(key)) schedule(key, 50);
			return store.get("repos", key);
		}
		const repo = store.upsert("repos", { id: key, root, name: basename(root.replace(/[\\/]+$/, "")), source, status: "pending", createdAt: Date.now() });
		schedule(key, 50);
		return repo;
	}

	function removeRepo(key) {
		clearTimeout(timers.get(key));
		timers.delete(key);
		scans.delete(key);
		store.remove("repos", key);
		for (const file of [scanFile(key), join(dir, `${key}.md`)]) rmSync(file, { force: true });
		invalidate();
	}

	function repoForPath(path) {
		const key = pathKey(path);
		return store
			.all("repos")
			.map((repo) => ({ repo, root: pathKey(repo.root) }))
			.filter(({ root }) => key === root || key.startsWith(`${root}/`))
			.sort((a, b) => b.root.length - a.root.length)[0]?.repo;
	}

	function touchPath(path, delay) {
		const repo = path ? repoForPath(path) : undefined;
		if (repo) schedule(repo.id, delay);
	}

	function relativeInRepo(repo, path) {
		return relative(repo.root, path).split("\\").join("/");
	}

	function activity() {
		const entries = [];
		for (const session of store.all("sessions")) {
			if (!session.online) continue;
			const repo = repoForPath(session.repoRoot || session.cwd || "") ?? store.all("repos").find((r) => r.name === session.repo);
			if (!repo) continue;
			entries.push({ sessionId: session.id, repo: repo.id });
			for (const file of (session.filesTouched ?? []).slice(-20)) {
				if (pathKey(file).startsWith(`${pathKey(repo.root)}/`)) entries.push({ sessionId: session.id, repo: repo.id, path: relativeInRepo(repo, file) });
			}
		}
		return entries;
	}

	function view(focus = ROOT_ID) {
		return viewGraph(currentModel(), focus || ROOT_ID, { activity: activity() });
	}

	function targetFor(text, session) {
		const current = currentModel();
		const repo = session ? repoForPath(session.repoRoot || session.cwd || "") : undefined;
		return resolveTarget(current, text, { repoKey: repo?.id });
	}

	function authorOf(role, session, name) {
		if (role === "agent") return { by: session?.id, byName: name ?? session?.name ?? session?.repo ?? "agent" };
		return { by: "human", byName: "you" };
	}

	function addNote({ target, text, role, session, name }) {
		const body = String(text ?? "").trim();
		if (!body) return { error: "note text is required", status: 400 };
		const id = targetFor(target, session);
		if (!id) return { error: `nothing in the graph matches "${target}"`, status: 404 };
		return { note: store.upsert("notes", { id: newId("note"), target: id, text: body.slice(0, MAX_NOTE), createdAt: Date.now(), ...authorOf(role, session, name) }) };
	}

	function addLink({ from, to, label, role, session, name }) {
		const fromId = targetFor(from, session);
		const toId = targetFor(to, session);
		const text = String(label ?? "").trim();
		if (!fromId || !toId) return { error: `could not find ${fromId ? to : from} in the graph`, status: 404 };
		if (fromId === toId || fromId === ROOT_ID || toId === ROOT_ID) return { error: "a link needs two different nodes", status: 400 };
		if (!text) return { error: "describe the relationship in label", status: 400 };
		return { link: store.upsert("graphLinks", { id: newId("link"), from: fromId, to: toId, label: text.slice(0, MAX_LABEL), createdAt: Date.now(), ...authorOf(role, session, name) }) };
	}

	function describe(target, session) {
		const id = targetFor(target ?? "", session);
		return id ? { id, text: describeNode(currentModel(), id) } : undefined;
	}

	function briefForPath(path) {
		const repo = path ? repoForPath(path) : undefined;
		if (!repo || !scans.has(repo.id)) return "";
		return describeNode(currentModel(), repoNodeId(repo.id)).slice(0, 4000);
	}

	function notesForPrompt(path) {
		const repo = path ? repoForPath(path) : undefined;
		if (!repo) return [];
		const current = currentModel();
		const prefix = [repoNodeId(repo.id), `dir:${repo.id}:`, `file:${repo.id}:`, `sym:${repo.id}:`];
		const shared = (note) => note.target === ROOT_ID;
		return store
			.all("notes")
			.filter((note) => shared(note) || note.target === prefix[0] || prefix.slice(1).some((p) => note.target.startsWith(p)))
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, 8)
			.map((note) => ({ where: shared(note) ? "workspace" : current.nodes.get(note.target)?.path || repo.name, text: note.text.slice(0, 300), by: note.byName }));
	}

	function diagramFor(files, path) {
		const repo = path ? repoForPath(path) : undefined;
		return changeDiagram(files, { model: repo && scans.has(repo.id) ? currentModel() : undefined, repoKey: repo?.id });
	}

	function close() {
		if (docsTimer) writeDocs();
		closed = true;
		unsubscribe();
		clearTimeout(docsTimer);
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	}

	return { addRepo, removeRepo, scan, schedule, touchPath, view, search: (query) => searchNodes(currentModel(), query), repoOf: (id) => currentModel().nodes.get(id)?.repo, labelOf: (id) => currentModel().nodes.get(id)?.label, addNote, addLink, describe, briefForPath, notesForPrompt, diagramFor, targetFor, repoForPath, writeDocs, close, dir };
}
