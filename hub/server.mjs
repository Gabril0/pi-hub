import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildId } from "./build.mjs";
import { pickColor } from "./colors.mjs";
import { HOST, HUB_DIR, LOG_FILE, PORT, ensureHubDir, loadConfig, mergeDeep, readToken, saveConfig } from "./config.mjs";
import { fetchPrForCwd, ghAvailable, prTransitions } from "./github.mjs";
import { createNotifier } from "./notify.mjs";
import { Store, newId, publicView } from "./store.mjs";
import { focusSession, openBrowser, spawnAgent } from "./terminal.mjs";
import { compareRuns, defaultTestCommand, flakyTests, parseTestOutput, stripAnsi } from "./test-parsers.mjs";

import { HUB_VERSION } from "./version.mjs";
export { HUB_VERSION };
const BUILD = buildId();

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff2": "font/woff2",
};
const OFFLINE_GRACE_MS = 8000;
const BODY_LIMIT = 64 * 1024 * 1024;

export function globToRegExp(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += glob[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, "i");
}

export function matchesAutoApprove(rules, { relPath, absPath, sessionName, tool }) {
	for (const rule of rules ?? []) {
		if (!rule?.glob) continue;
		if (rule.tool && rule.tool !== tool) continue;
		if (rule.session && rule.session.toLowerCase() !== String(sessionName ?? "").toLowerCase()) continue;
		const regex = globToRegExp(rule.glob.replace(/\\/g, "/"));
		if (regex.test(relPath) || regex.test(absPath)) return rule;
	}
	return undefined;
}

export function pathKey(path) {
	const resolved = toPosix(resolve(String(path ?? "")));
	return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function toPosix(path) {
	return String(path ?? "").split(sep).join("/");
}

function excerpt(text, max = 280) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function createHub({ port = PORT, stateFile, silent = false, openBrowserFn = openBrowser, onShutdown } = {}) {
	ensureHubDir();
	const token = readToken();
	let config = loadConfig();
	const store = new Store(stateFile);
	const channels = new Map();
	const browsers = new Set();
	const offlineTimers = new Map();
	const runningTests = new Map();
	let lastBrowserOpen = 0;
	let actualPort = port;

	const baseUrl = () => `http://${HOST}:${actualPort}/?token=${token}`;
	const notify = silent ? () => {} : createNotifier(() => config, baseUrl);

	function log(line) {
		try {
			appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
		} catch {}
	}

	for (const session of store.all("sessions")) {
		if (session.online) store.patch("sessions", session.id, { online: false, status: "offline" });
	}
	for (const review of store.all("reviews")) {
		if (review.status === "pending" || review.status === "thinking") store.patch("reviews", review.id, { status: "stale" });
	}

	store.subscribe((message) => {
		const payload = `data: ${JSON.stringify(message)}\n\n`;
		for (const res of browsers) res.write(payload);
	});

	function sendToSession(sessionId, message) {
		const set = channels.get(sessionId);
		if (!set?.size) return false;
		const payload = `data: ${JSON.stringify(message)}\n\n`;
		for (const res of set) res.write(payload);
		return true;
	}

	function sessionLabel(session) {
		return session?.name || session?.repo || session?.cwd?.split(/[\\/]/).pop() || session?.id;
	}

	function addInbox(item) {
		const entry = store.upsert("inbox", { id: newId("in"), createdAt: Date.now(), resolved: false, ...item });
		const session = store.get("sessions", item.sessionId);
		notify({
			kind: item.kind,
			title: `${session ? `[${sessionLabel(session)}] ` : ""}${item.title}`,
			body: item.body ?? "",
			path: item.path,
		});
		return entry;
	}

	function resolveInbox(predicate, fields = {}) {
		for (const item of store.all("inbox")) {
			if (!item.resolved && predicate(item)) store.patch("inbox", item.id, { resolved: true, resolvedAt: Date.now(), ...fields });
		}
	}

	function maybeOpenBrowser(path) {
		if (!config.openBrowserOnReview || browsers.size > 0 || silent) return;
		if (Date.now() - lastBrowserOpen < 60000) return;
		lastBrowserOpen = Date.now();
		openBrowserFn(`${baseUrl()}${path ?? ""}`);
	}

	function findSession(target) {
		const needle = String(target ?? "").toLowerCase().trim();
		const sessions = store.all("sessions");
		return (
			sessions.find((s) => s.id.toLowerCase() === needle) ??
			sessions.find((s) => s.online && String(s.name ?? "").toLowerCase() === needle) ??
			sessions.find((s) => s.online && s.color?.name === needle) ??
			sessions.find((s) => String(s.name ?? "").toLowerCase() === needle) ??
			sessions.find((s) => s.online && String(s.repo ?? "").toLowerCase() === needle)
		);
	}

	function registerSession(body) {
		const sessions = store.all("sessions");
		const previous = store.get("sessions", body.id);
		const color = pickColor(sessions, body.id);
		const session = store.upsert("sessions", {
			createdAt: previous?.createdAt ?? Date.now(),
			status: previous?.status && previous.status !== "offline" ? previous.status : "idle",
			trust: previous?.trust ?? "review",
			usage: previous?.usage ?? { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			turns: previous?.turns ?? 0,
			filesTouched: previous?.filesTouched ?? [],
			...body,
			color,
			online: true,
			lastSeen: Date.now(),
		});
		log(`register ${session.id} ${session.cwd}`);
		return session;
	}

	function markOnline(sessionId, online) {
		clearTimeout(offlineTimers.get(sessionId));
		if (online) {
			store.patch("sessions", sessionId, { online: true, lastSeen: Date.now(), status: store.get("sessions", sessionId)?.status === "offline" ? "idle" : store.get("sessions", sessionId)?.status });
			return;
		}
		offlineTimers.set(
			sessionId,
			setTimeout(() => {
				if (channels.get(sessionId)?.size) return;
				store.patch("sessions", sessionId, { online: false, status: "offline", lastSeen: Date.now() });
				for (const review of store.all("reviews")) {
					if (review.sessionId === sessionId && (review.status === "pending" || review.status === "thinking")) store.patch("reviews", review.id, { status: "stale" });
				}
				resolveInbox((item) => item.sessionId === sessionId && ["review", "question"].includes(item.kind), { outcome: "session offline" });
			}, OFFLINE_GRACE_MS),
		);
	}

	function touchFile(sessionId, absPath) {
		const session = store.get("sessions", sessionId);
		if (!session) return;
		const files = new Set(session.filesTouched ?? []);
		if ([...files].some((f) => pathKey(f) === pathKey(absPath))) return;
		files.add(absPath);
		store.patch("sessions", sessionId, { filesTouched: [...files].slice(-500) });
	}

	function findConflicts(sessionId, absPath) {
		const cutoff = Date.now() - 12 * 3600 * 1000;
		const key = pathKey(absPath);
		return store
			.all("sessions")
			.filter((s) => s.id !== sessionId && (s.online || (s.lastSeen ?? 0) > cutoff))
			.filter((s) => (s.filesTouched ?? []).some((f) => pathKey(f) === key) || store.all("reviews").some((r) => r.sessionId === s.id && pathKey(r.absPath) === key && r.status === "pending"))
			.map((s) => ({ sessionId: s.id, name: sessionLabel(s), color: s.color }));
	}

	function handleEvent(sessionId, event) {
		const session = store.get("sessions", sessionId);
		if (!session) return;
		const now = Date.now();
		switch (event.kind) {
			case "agent_start":
				store.patch("sessions", sessionId, { status: "working", currentPrompt: excerpt(event.prompt, 400), runStartedAt: now, runTurns: 0, lastActivity: now });
				store.appendEvent(sessionId, { kind: "agent_start", text: excerpt(event.prompt, 600) });
				break;
			case "turn_end":
				store.patch("sessions", sessionId, { turns: (session.turns ?? 0) + 1, runTurns: (session.runTurns ?? 0) + 1, lastActivity: now });
				break;
			case "tool_start":
				store.patch("sessions", sessionId, { lastTool: { name: event.toolName, summary: excerpt(event.summary, 160), at: now }, lastActivity: now });
				store.appendEvent(sessionId, { kind: "tool", toolName: event.toolName, text: excerpt(event.summary, 300), toolCallId: event.toolCallId });
				break;
			case "tool_end":
				if (event.isError) store.appendEvent(sessionId, { kind: "tool_error", toolName: event.toolName, text: excerpt(event.summary, 400) });
				break;
			case "assistant":
				store.patch("sessions", sessionId, { lastMessage: excerpt(event.text, 500), lastActivity: now });
				store.appendEvent(sessionId, { kind: "assistant", text: excerpt(event.text, 1200) });
				break;
			case "usage": {
				const usage = { ...(session.usage ?? {}) };
				for (const key of ["cost", "input", "output", "cacheRead", "cacheWrite"]) usage[key] = (usage[key] ?? 0) + (event[key] ?? 0);
				store.patch("sessions", sessionId, { usage });
				break;
			}
			case "agent_end": {
				const duration = session.runStartedAt ? now - session.runStartedAt : undefined;
				store.patch("sessions", sessionId, { status: event.error ? "error" : "idle", lastActivity: now, lastError: event.error });
				store.appendEvent(sessionId, { kind: "agent_end", text: excerpt(event.text, 600), error: event.error });
				if (event.text || event.error) {
					store.upsert("results", {
						id: newId("res"),
						sessionId,
						createdAt: now,
						prompt: session.currentPrompt,
						text: event.text ?? "",
						error: event.error,
						durationMs: duration,
						turns: session.runTurns,
						cost: session.usage?.cost,
						files: event.files ?? [],
					});
				}
				if (event.error) addInbox({ kind: "error", sessionId, title: "Agent errored", body: excerpt(event.error, 200), path: `#/agents/${sessionId}` });
				else addInbox({ kind: "done", sessionId, title: "Agent finished", body: excerpt(event.text, 200), path: `#/agents/${sessionId}` });
				break;
			}
			case "progress":
				store.patch("sessions", sessionId, { progress: { steps: event.steps ?? [], note: event.note, at: now } });
				store.appendEvent(sessionId, { kind: "progress", text: excerpt(event.note ?? `${(event.steps ?? []).filter((s) => s.status === "done").length}/${(event.steps ?? []).length} steps`, 300) });
				break;
			case "summary":
				store.patch("sessions", sessionId, { summary: { text: event.text, at: now } });
				store.appendEvent(sessionId, { kind: "summary", text: excerpt(event.text, 800) });
				break;
			case "error":
				store.appendEvent(sessionId, { kind: "error", text: excerpt(event.text, 600) });
				break;
			default:
				store.appendEvent(sessionId, { kind: event.kind ?? "event", text: excerpt(event.text ?? JSON.stringify(event), 400) });
		}
	}

	function createReview(body) {
		const session = store.get("sessions", body.sessionId);
		const rawAbsPath = String(body.absPath ?? "");
		const absPath = isAbsolute(rawAbsPath) || /^[\/]/.test(rawAbsPath) ? rawAbsPath : resolve(rawAbsPath);
		const relPath = toPosix(session?.cwd ? relative(session.cwd, absPath) : body.path);
		const id = newId("rv");
		const conflicts = findConflicts(body.sessionId, absPath);
		const rule = matchesAutoApprove(config.review.autoApprove, { relPath, absPath: toPosix(absPath), sessionName: session?.name, tool: body.tool });
		const auto = session?.trust === "auto" ? "session trust" : rule ? `rule ${rule.glob}` : undefined;
		if (!body.snippetOnly && ![...store.sessionBaselines(body.sessionId).keys()].some((p) => pathKey(p) === pathKey(absPath))) store.recordBaseline(body.sessionId, absPath, body.oldContent ?? "");
		touchFile(body.sessionId, absPath);
		const review = store.upsert("reviews", {
			id,
			sessionId: body.sessionId,
			toolCallId: body.toolCallId,
			tool: body.tool,
			path: relPath,
			absPath,
			isNew: Boolean(body.isNew),
			snippetOnly: Boolean(body.snippetOnly),
			oldContent: body.oldContent ?? "",
			revisions: [{ n: 1, content: body.newContent ?? "", note: "proposed by agent", by: "agent", at: Date.now() }],
			chat: [],
			conflicts,
			reason: body.reason,
			status: auto ? "approved" : "pending",
			auto,
			createdAt: Date.now(),
			decidedAt: auto ? Date.now() : undefined,
		});
		store.appendEvent(body.sessionId, { kind: "review", text: `${auto ? `auto-approved (${auto})` : "review requested"}: ${relPath}`, reviewId: id });
		if (conflicts.length) {
			addInbox({ kind: "conflict", sessionId: body.sessionId, refId: id, title: `Conflict on ${relPath}`, body: `Also touched by ${conflicts.map((c) => c.name).join(", ")}`, path: `#/review/${id}` });
		}
		if (!auto) {
			addInbox({ kind: "review", sessionId: body.sessionId, refId: id, title: `Review ${body.tool}: ${relPath}`, body: body.reason ?? "", path: `#/review/${id}` });
			store.patch("sessions", body.sessionId, { status: "waiting" });
			maybeOpenBrowser(`#/review/${id}`);
		}
		return review;
	}

	function decideReview(id, body) {
		const review = store.get("reviews", id);
		if (!review) return { status: 404, body: { error: "review not found" } };
		if (!["pending", "thinking"].includes(review.status)) return { status: 409, body: { error: `review is ${review.status}` } };
		const decision = body.decision === "approve" ? "approved" : "denied";
		const latest = review.revisions.at(-1).content;
		const content = typeof body.content === "string" ? body.content : latest;
		const updated = store.patch("reviews", id, {
			status: decision,
			decidedAt: Date.now(),
			comment: body.comment,
			lineComments: body.lineComments ?? [],
			finalContent: decision === "approved" ? content : undefined,
			partial: decision === "approved" && content !== latest,
		});
		resolveInbox((item) => item.refId === id && item.kind === "review", { outcome: decision });
		const delivered = sendToSession(review.sessionId, {
			type: "review_decision",
			reviewId: id,
			decision,
			comment: body.comment,
			lineComments: body.lineComments ?? [],
			content: decision === "approved" ? content : undefined,
		});
		store.appendEvent(review.sessionId, { kind: "review", text: `${decision}: ${review.path}${body.comment ? ` — ${excerpt(body.comment, 200)}` : ""}`, reviewId: id });
		refreshWaiting(review.sessionId);
		return { status: 200, body: { review: publicView("reviews", updated), delivered } };
	}

	function refreshWaiting(sessionId) {
		const session = store.get("sessions", sessionId);
		if (!session || session.status !== "waiting") return;
		const pending = store.all("reviews").some((r) => r.sessionId === sessionId && ["pending", "thinking"].includes(r.status));
		const asking = store.all("inbox").some((i) => i.sessionId === sessionId && i.kind === "question" && !i.resolved);
		if (!pending && !asking) store.patch("sessions", sessionId, { status: "working" });
	}

	function runTests({ sessionId, cwd, command }) {
		const session = sessionId ? store.get("sessions", sessionId) : undefined;
		const workdir = cwd || session?.cwd;
		if (!workdir || !existsSync(workdir)) return { status: 400, body: { error: "no working directory" } };
		const cmd = command || defaultTestCommand(readdirSync(workdir));
		if (!cmd) return { status: 400, body: { error: "no test command detected" } };
		const id = newId("tr");
		const startedAt = Date.now();
		store.upsert("testRuns", { id, sessionId, cwd: workdir, command: cmd, source: "hub", status: "running", startedAt, createdAt: startedAt, outputTail: "" });
		const child = spawn(cmd, { cwd: workdir, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", CARGO_TERM_COLOR: "never", NO_COLOR: "1" } });
		runningTests.set(id, child);
		let output = "";
		let flushTimer = null;
		const onData = (chunk) => {
			output += chunk.toString();
			if (output.length > 4_000_000) output = output.slice(-2_000_000);
			if (!flushTimer) {
				flushTimer = setTimeout(() => {
					flushTimer = null;
					store.patch("testRuns", id, { outputTail: stripAnsi(output.slice(-6000)) });
				}, 400);
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (error) => onData(Buffer.from(`\n${error.message}\n`)));
		child.on("close", (code) => {
			clearTimeout(flushTimer);
			runningTests.delete(id);
			finishTestRun(id, { command: cmd, output, exitCode: code, sessionId, cwd: workdir, startedAt });
		});
		return { status: 200, body: { id, command: cmd } };
	}

	function finishTestRun(id, { command, output, exitCode, sessionId, cwd, startedAt, source }) {
		const parsed = parseTestOutput(command, output, exitCode);
		const history = store
			.all("testRuns")
			.filter((r) => r.id !== id && r.cwd === cwd && r.command === command && r.status !== "running")
			.sort((a, b) => b.createdAt - a.createdAt);
		const comparison = compareRuns(history[0], parsed);
		const flaky = flakyTests([...history.slice(0, 9).reverse(), parsed]);
		const run = store.upsert("testRuns", {
			id,
			sessionId,
			cwd,
			command,
			source: source ?? store.get("testRuns", id)?.source ?? "agent",
			createdAt: store.get("testRuns", id)?.createdAt ?? Date.now(),
			startedAt,
			durationMs: startedAt ? Date.now() - startedAt : undefined,
			exitCode,
			framework: parsed.framework,
			status: parsed.status,
			summary: parsed.summary,
			tests: parsed.tests.map((t) => ({ ...t, output: t.output ? String(t.output).slice(0, 8000) : undefined })),
			outputTail: stripAnsi(output.slice(-12000)),
			newFailures: comparison.newFailures,
			fixed: comparison.fixed,
			flaky,
		});
		if (sessionId) {
			store.appendEvent(sessionId, { kind: "test", text: `${command}: ${parsed.status} (${parsed.summary.passed}✓ ${parsed.summary.failed}✗)`, testRunId: id });
			store.patch("sessions", sessionId, { lastTest: { id, status: parsed.status, summary: parsed.summary, at: Date.now() } });
		}
		if (parsed.status !== "passed") {
			addInbox({
				kind: "test_fail",
				sessionId,
				refId: id,
				title: `Tests ${parsed.status}: ${excerpt(command, 60)}`,
				body: comparison.newFailures.length ? `New failures: ${comparison.newFailures.slice(0, 5).join(", ")}` : `${parsed.summary.failed} failing`,
				path: `#/tests/${id}`,
			});
		}
		return run;
	}

	const prState = new Map();
	async function pollPrs() {
		if (!ghAvailable()) return;
		const cwds = new Map();
		for (const session of store.all("sessions")) {
			if (session.online && session.cwd && session.isGitRepo !== false) cwds.set(session.cwd, session);
		}
		for (const [cwd, session] of cwds) {
			const pr = await fetchPrForCwd(cwd);
			if (!pr) continue;
			const previous = prState.get(pr.id) ?? store.get("prs", pr.id);
			const sessionIds = new Set(store.get("prs", pr.id)?.sessionIds ?? []);
			sessionIds.add(session.id);
			const saved = store.upsert("prs", { ...pr, sessionIds: [...sessionIds], sessionId: session.id, lastPolled: Date.now(), createdAt: previous?.createdAt ?? Date.now() });
			prState.set(pr.id, saved);
			for (const change of prTransitions(previous, pr)) {
				addInbox({ kind: "pr", sessionId: session.id, refId: pr.id, title: `PR #${pr.number} ${change}`, body: pr.title, path: "#/prs" });
			}
		}
	}

	async function readBody(req) {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > BODY_LIMIT) throw Object.assign(new Error("body too large"), { status: 413 });
			chunks.push(chunk);
		}
		if (!chunks.length) return {};
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}

	function authorized(req, url) {
		if (req.headers["x-hub-token"] === token) return true;
		return req.method === "GET" && url.searchParams.get("token") === token;
	}

	function sameOrigin(req) {
		const site = req.headers["sec-fetch-site"];
		if (site && !["same-origin", "none"].includes(site)) return false;
		const origin = req.headers.origin;
		if (!origin) return true;
		return origin === `http://${HOST}:${actualPort}` || origin === `http://localhost:${actualPort}`;
	}

	function json(res, status, body) {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	}

	function openSse(req, res) {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		res.write(": connected\n\n");
		const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
		req.on("close", () => clearInterval(heartbeat));
	}

	function serveStatic(req, res, url) {
		let path = decodeURIComponent(url.pathname);
		if (path === "/") path = "/index.html";
		const file = resolve(WEB_DIR, `.${path}`);
		if (!file.startsWith(resolve(WEB_DIR)) || !existsSync(file) || statSync(file).isDirectory()) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const headers = { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" };
		res.writeHead(200, headers);
		res.end(readFileSync(file));
	}

	const routes = [];
	const route = (method, pattern, handler) => {
		const keys = [];
		const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), "([^/]+)"))}$`);
		routes.push({ method, regex, keys, handler });
	};

	route("GET", "/api/health", () => ({ ok: true, version: HUB_VERSION, build: BUILD, pid: process.pid }));

	route("GET", "/api/state", () => ({
		...store.snapshot(),
		reviews: store.all("reviews").map((r) => publicView("reviews", r)),
		config,
		hub: { version: HUB_VERSION, pid: process.pid, platform: process.platform, dir: HUB_DIR, gh: ghAvailable() },
	}));

	route("GET", "/api/stream", ({ req, res }) => {
		openSse(req, res);
		browsers.add(res);
		req.on("close", () => browsers.delete(res));
		return null;
	});

	route("PUT", "/api/config", ({ body }) => {
		config = mergeDeep(config, body);
		saveConfig(config);
		store.emit({ t: "config", config });
		for (const sessionId of channels.keys()) sendToSession(sessionId, { type: "config", config });
		return { config };
	});

	route("POST", "/api/sessions/register", ({ body }) => {
		if (!body.id) return [400, { error: "id required" }];
		return { session: registerSession(body) };
	});

	route("GET", "/api/sessions/:id/channel", ({ req, res, params }) => {
		const session = store.get("sessions", params.id);
		if (!session) return [404, { error: "unknown session" }];
		openSse(req, res);
		const set = channels.get(params.id) ?? new Set();
		set.add(res);
		channels.set(params.id, set);
		markOnline(params.id, true);
		req.on("close", () => {
			set.delete(res);
			if (!set.size) markOnline(params.id, false);
		});
		return null;
	});

	route("POST", "/api/sessions/:id/events", ({ body, params }) => {
		for (const event of body.events ?? []) handleEvent(params.id, event);
		store.patch("sessions", params.id, { lastSeen: Date.now() });
		return { ok: true };
	});

	route("POST", "/api/sessions/:id/state", ({ body, params }) => {
		const { id: _ignored, color: _color, ...fields } = body;
		const session = store.patch("sessions", params.id, { ...fields, lastSeen: Date.now() });
		return session ? { session } : [404, { error: "unknown session" }];
	});

	route("DELETE", "/api/sessions/:id", ({ params }) => {
		store.forgetSession(params.id);
		return { ok: true };
	});

	route("GET", "/api/sessions/:id/events", ({ params, url }) => ({ events: store.sessionEvents(params.id, Number(url.searchParams.get("limit") ?? 200)) }));

	route("GET", "/api/sessions/:id/changes", ({ params }) => {
		const files = [];
		for (const [absPath, baseline] of store.sessionBaselines(params.id)) {
			let current = "";
			let exists = false;
			try {
				current = readFileSync(absPath, "utf8");
				exists = true;
			} catch {}
			const session = store.get("sessions", params.id);
			files.push({ absPath, path: toPosix(session?.cwd ? relative(session.cwd, absPath) : absPath), baseline, current, exists, changed: baseline !== current });
		}
		return { files };
	});

	route("POST", "/api/sessions/:id/message", ({ params, body }) => {
		const session = store.get("sessions", params.id);
		if (!session) return [404, { error: "unknown session" }];
		const message = store.upsert("messages", { id: newId("msg"), from: "human", fromName: "you", to: params.id, body: body.text, deliverAs: body.deliverAs ?? "steer", createdAt: Date.now() });
		const delivered = sendToSession(params.id, { type: "user_message", text: body.text, deliverAs: body.deliverAs ?? "steer", messageId: message.id });
		store.appendEvent(params.id, { kind: "message_in", text: `you: ${excerpt(body.text, 400)}` });
		return { delivered };
	});

	route("POST", "/api/broadcast", ({ body }) => {
		const targets = store.all("sessions").filter((s) => s.online);
		for (const session of targets) {
			sendToSession(session.id, { type: "user_message", text: body.text, deliverAs: body.deliverAs ?? "followUp" });
			store.appendEvent(session.id, { kind: "message_in", text: `you (broadcast): ${excerpt(body.text, 400)}` });
		}
		store.upsert("messages", { id: newId("msg"), from: "human", fromName: "you", to: "*", body: body.text, createdAt: Date.now() });
		return { delivered: targets.length };
	});

	route("POST", "/api/sessions/:id/abort", ({ params }) => ({ delivered: sendToSession(params.id, { type: "abort" }) }));
	route("POST", "/api/sessions/:id/summarize", ({ params }) => ({ delivered: sendToSession(params.id, { type: "summarize" }) }));
	route("POST", "/api/sessions/:id/trust", ({ params, body }) => {
		const session = store.patch("sessions", params.id, { trust: body.mode === "auto" ? "auto" : "review" });
		if (session) sendToSession(params.id, { type: "trust", mode: session.trust });
		return { session };
	});
	route("POST", "/api/sessions/:id/focus", async ({ params }) => {
		const session = store.get("sessions", params.id);
		if (!session) return [404, { error: "unknown session" }];
		return { steps: await focusSession(session) };
	});
	route("POST", "/api/sessions/:id/rename", ({ params, body }) => {
		const session = store.patch("sessions", params.id, { name: body.name });
		if (session) sendToSession(params.id, { type: "rename", name: body.name });
		return { session };
	});

	route("POST", "/api/reviews", ({ body }) => {
		const review = createReview(body);
		return { id: review.id, status: review.status, auto: review.auto, conflicts: review.conflicts };
	});
	route("GET", "/api/reviews/:id", ({ params }) => {
		const review = store.get("reviews", params.id);
		return review ? { review } : [404, { error: "review not found" }];
	});
	route("POST", "/api/reviews/:id/decision", ({ params, body }) => {
		const result = decideReview(params.id, body);
		return [result.status, result.body];
	});
	route("POST", "/api/reviews/:id/ask", ({ params, body }) => {
		const review = store.get("reviews", params.id);
		if (!review || review.status !== "pending") return [409, { error: "review not pending" }];
		const chat = [...review.chat, { role: "user", kind: "ask", text: body.text, at: Date.now(), lineComments: body.lineComments }];
		store.patch("reviews", params.id, { chat, status: "thinking" });
		const delivered = sendToSession(review.sessionId, { type: "review_ask", reviewId: params.id, text: body.text, lineComments: body.lineComments ?? [] });
		if (!delivered) store.patch("reviews", params.id, { status: "pending", chat: [...chat, { role: "system", text: "Agent is offline.", at: Date.now() }] });
		return { delivered };
	});
	route("POST", "/api/reviews/:id/revise", ({ params, body }) => {
		const review = store.get("reviews", params.id);
		if (!review || review.status !== "pending") return [409, { error: "review not pending" }];
		const chat = [...review.chat, { role: "user", kind: "revise", text: body.text, at: Date.now(), lineComments: body.lineComments }];
		store.patch("reviews", params.id, { chat, status: "thinking" });
		const delivered = sendToSession(review.sessionId, { type: "review_revise", reviewId: params.id, text: body.text, lineComments: body.lineComments ?? [] });
		if (!delivered) store.patch("reviews", params.id, { status: "pending", chat: [...chat, { role: "system", text: "Agent is offline.", at: Date.now() }] });
		return { delivered };
	});
	route("POST", "/api/reviews/:id/chat", ({ params, body }) => {
		const review = store.get("reviews", params.id);
		if (!review) return [404, { error: "review not found" }];
		const status = review.status === "thinking" && body.done !== false ? "pending" : review.status;
		store.patch("reviews", params.id, { chat: [...review.chat, { role: body.role ?? "agent", text: body.text, at: Date.now() }], status });
		return { ok: true };
	});
	route("POST", "/api/reviews/:id/revision", ({ params, body }) => {
		const review = store.get("reviews", params.id);
		if (!review) return [404, { error: "review not found" }];
		if (!["pending", "thinking"].includes(review.status)) return [409, { error: `review is ${review.status}` }];
		const revisions = [...review.revisions, { n: review.revisions.length + 1, content: body.content, note: body.note ?? "revised", by: body.by ?? "agent", at: Date.now() }];
		const chat = body.note ? [...review.chat, { role: "agent", text: body.note, at: Date.now(), revision: revisions.length }] : review.chat;
		store.patch("reviews", params.id, { revisions, chat, status: review.status === "thinking" ? "pending" : review.status });
		notify({ kind: "review", title: `Revision v${revisions.length}: ${review.path}`, body: body.note ?? "", path: `#/review/${params.id}` });
		return { revision: revisions.length };
	});
	route("POST", "/api/reviews/:id/cancel", ({ params, body }) => {
		const review = store.get("reviews", params.id);
		if (!review) return [404, { error: "review not found" }];
		if (["pending", "thinking", "stale"].includes(review.status)) store.patch("reviews", params.id, { status: "cancelled", cancelReason: body.reason });
		resolveInbox((item) => item.refId === params.id && item.kind === "review", { outcome: "cancelled" });
		refreshWaiting(review.sessionId);
		return { ok: true };
	});
	route("POST", "/api/reviews/:id/applied", ({ params, body }) => {
		const review = store.patch("reviews", params.id, { applied: body.ok !== false, applyError: body.error });
		return review ? { ok: true } : [404, { error: "review not found" }];
	});

	route("POST", "/api/questions", ({ body }) => {
		const item = addInbox({ kind: "question", sessionId: body.sessionId, title: excerpt(body.question, 120), body: body.question, options: body.options ?? [], path: `#/inbox` });
		store.patch("sessions", body.sessionId, { status: "waiting" });
		store.appendEvent(body.sessionId, { kind: "question", text: excerpt(body.question, 400) });
		maybeOpenBrowser("#/inbox");
		return { id: item.id };
	});
	route("POST", "/api/inbox/:id/answer", ({ params, body }) => {
		const item = store.get("inbox", params.id);
		if (!item || item.kind !== "question" || item.resolved) return [409, { error: "question not open" }];
		store.patch("inbox", params.id, { resolved: true, resolvedAt: Date.now(), answer: body.text, outcome: "answered" });
		const delivered = sendToSession(item.sessionId, { type: "answer", questionId: params.id, text: body.text });
		store.appendEvent(item.sessionId, { kind: "answer", text: `you: ${excerpt(body.text, 300)}` });
		refreshWaiting(item.sessionId);
		return { delivered };
	});
	route("GET", "/api/inbox/:id", ({ params }) => {
		const item = store.get("inbox", params.id);
		return item ? { item } : [404, { error: "not found" }];
	});
	route("POST", "/api/inbox/:id/resolve", ({ params, body }) => {
		const item = store.get("inbox", params.id);
		if (!item) return [404, { error: "not found" }];
		store.patch("inbox", params.id, { resolved: true, resolvedAt: Date.now(), outcome: body.outcome ?? "dismissed", answer: body.answer ?? item.answer });
		if (item.kind === "question") refreshWaiting(item.sessionId);
		return { ok: true };
	});
	route("POST", "/api/inbox/resolve-all", ({ body }) => {
		resolveInbox((item) => !["review", "question"].includes(item.kind) && (!body.kind || item.kind === body.kind), { outcome: "dismissed" });
		return { ok: true };
	});

	route("GET", "/api/agents", () => ({
		agents: store
			.all("sessions")
			.filter((s) => s.online)
			.map((s) => ({ id: s.id, name: sessionLabel(s), color: s.color?.name, cwd: s.cwd, repo: s.repo, branch: s.branch, status: s.status, task: s.currentPrompt, progress: s.progress, summary: s.summary?.text })),
	}));
	route("POST", "/api/messages", ({ body }) => {
		const fromSession = store.get("sessions", body.from);
		const fromName = sessionLabel(fromSession) ?? body.from;
		if (String(body.to).toLowerCase() === "human") {
			const message = store.upsert("messages", { id: newId("msg"), from: body.from, fromName, to: "human", body: body.body, createdAt: Date.now() });
			addInbox({ kind: "message", sessionId: body.from, title: `Message from ${fromName}`, body: body.body, refId: message.id, path: "#/inbox" });
			store.appendEvent(body.from, { kind: "message_out", text: `→ you: ${excerpt(body.body, 400)}` });
			return { delivered: true, to: "human" };
		}
		const target = findSession(body.to);
		if (!target) return [404, { error: `no agent named ${body.to}` }];
		store.upsert("messages", { id: newId("msg"), from: body.from, fromName, to: target.id, toName: sessionLabel(target), body: body.body, createdAt: Date.now() });
		const delivered = sendToSession(target.id, { type: "agent_message", from: body.from, fromName, body: body.body });
		store.appendEvent(body.from, { kind: "message_out", text: `→ ${sessionLabel(target)}: ${excerpt(body.body, 400)}` });
		store.appendEvent(target.id, { kind: "message_in", text: `${fromName}: ${excerpt(body.body, 400)}` });
		return { delivered, to: target.id, toName: sessionLabel(target) };
	});

	route("GET", "/api/tasks", () => ({ tasks: store.all("tasks") }));
	route("POST", "/api/tasks", ({ body }) => {
		const task = store.upsert("tasks", { id: newId("task"), status: "todo", deps: [], createdAt: Date.now(), notes: [], ...body });
		if (task.owner) sendToSession(task.owner, { type: "task_assigned", task });
		return { task };
	});
	route("PATCH", "/api/tasks/:id", ({ params, body }) => {
		const previous = store.get("tasks", params.id);
		if (!previous) return [404, { error: "task not found" }];
		const notes = body.note ? [...(previous.notes ?? []), { text: body.note, by: body.by ?? "human", at: Date.now() }] : previous.notes;
		const { note: _note, by: _by, ...fields } = body;
		const task = store.patch("tasks", params.id, { ...fields, notes });
		if (fields.owner && fields.owner !== previous.owner) sendToSession(fields.owner, { type: "task_assigned", task });
		if (fields.status === "done" && previous.status !== "done") {
			for (const dependent of store.all("tasks").filter((t) => (t.deps ?? []).includes(params.id) && t.owner)) {
				sendToSession(dependent.owner, { type: "task_unblocked", task: dependent, unblockedBy: task });
			}
		}
		return { task };
	});
	route("DELETE", "/api/tasks/:id", ({ params }) => {
		store.remove("tasks", params.id);
		for (const task of store.all("tasks")) {
			if ((task.deps ?? []).includes(params.id)) store.patch("tasks", task.id, { deps: task.deps.filter((d) => d !== params.id) });
		}
		return { ok: true };
	});

	route("POST", "/api/tests/run", ({ body }) => {
		const result = runTests(body);
		return [result.status, result.body];
	});
	route("POST", "/api/tests/:id/stop", ({ params }) => {
		const child = runningTests.get(params.id);
		if (child) child.kill();
		return { ok: Boolean(child) };
	});
	route("POST", "/api/tests/ingest", ({ body }) => {
		const id = newId("tr");
		const run = finishTestRun(id, { command: body.command, output: body.output ?? "", exitCode: body.exitCode, sessionId: body.sessionId, cwd: body.cwd, source: "agent" });
		return { id: run.id, status: run.status };
	});
	route("GET", "/api/tests/:id", ({ params }) => {
		const run = store.get("testRuns", params.id);
		return run ? { run } : [404, { error: "not found" }];
	});
	route("GET", "/api/tests-default", ({ url }) => {
		const cwd = url.searchParams.get("cwd");
		if (!cwd || !existsSync(cwd)) return { command: "" };
		return { command: defaultTestCommand(readdirSync(cwd)) };
	});

	route("POST", "/api/prs/refresh", async () => {
		await pollPrs();
		return { prs: store.all("prs") };
	});

	route("POST", "/api/spawn", async ({ body }) => {
		const cwd = body.cwd && isAbsolute(body.cwd) ? body.cwd : undefined;
		if (!cwd || !existsSync(cwd)) return [400, { error: "cwd must be an existing absolute path" }];
		const reference = store.all("sessions").find((s) => s.online && s.tmuxSocket);
		const result = await spawnAgent({ cwd, prompt: body.prompt, name: body.name, piCommand: config.piCommand ?? "pi", tmuxSocket: reference?.tmuxSocket, termProgram: reference?.termProgram });
		log(`spawn ${cwd} via ${result.via} ok=${result.ok}`);
		return result;
	});

	route("POST", "/api/results/:id/delete", ({ params }) => {
		store.remove("results", params.id);
		return { ok: true };
	});

	route("POST", "/api/shutdown", () => {
		setTimeout(() => close().then(() => onShutdown?.()), 50);
		return { ok: true };
	});

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${HOST}`);
			if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url);
			if (url.pathname !== "/api/health" && !authorized(req, url)) return json(res, 401, { error: "unauthorized" });
			if (req.method !== "GET" && !sameOrigin(req)) return json(res, 403, { error: "cross-origin request rejected" });
			const match = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
			if (!match) return json(res, 404, { error: "no route" });
			const values = url.pathname.match(match.regex).slice(1);
			const params = Object.fromEntries(match.keys.map((key, i) => [key, decodeURIComponent(values[i])]));
			const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};
			const result = await match.handler({ req, res, url, params, body });
			if (result === null) return;
			if (Array.isArray(result)) return json(res, result[0], result[1]);
			json(res, 200, result);
		} catch (error) {
			log(`error ${req.method} ${req.url}: ${error.stack ?? error}`);
			if (!res.headersSent) json(res, error instanceof URIError ? 400 : error.status ?? 500, { error: error.message });
		}
	});

	function pruneSessions() {
		const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
		for (const session of store.all("sessions")) {
			if (!session.online && (session.lastSeen ?? 0) < cutoff) store.forgetSession(session.id);
		}
	}
	pruneSessions();
	const pruneTimer = setInterval(pruneSessions, 3600 * 1000);
	pruneTimer.unref?.();

	let prTimer = null;
	function schedulePrPoll() {
		clearTimeout(prTimer);
		prTimer = setTimeout(async () => {
			try {
				await pollPrs();
			} catch {}
			schedulePrPoll();
		}, Math.max(30, config.prPollSeconds ?? 90) * 1000);
		prTimer.unref?.();
	}

	function listen() {
		return new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(port, HOST, () => {
				actualPort = server.address().port;
				log(`hub listening on ${actualPort} pid ${process.pid}`);
				schedulePrPoll();
				resolveListen(actualPort);
			});
		});
	}

	function close() {
		clearTimeout(prTimer);
		clearInterval(pruneTimer);
		for (const timer of offlineTimers.values()) clearTimeout(timer);
		for (const child of runningTests.values()) child.kill();
		for (const set of channels.values()) for (const res of set) res.end();
		for (const res of browsers) res.end();
		store.flush();
		server.closeAllConnections?.();
		return new Promise((done) => server.close(() => done()));
	}

	return { listen, close, store, token, url: baseUrl, get port() {
		return actualPort;
	} };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
	const hub = createHub({ onShutdown: () => process.exit(0) });
	hub
		.listen()
		.then((port) => {
			writeFileSync(join(HUB_DIR, "hub.pid"), String(process.pid));
			console.log(`pi hub on http://${HOST}:${port}`);
		})
		.catch((error) => {
			console.error(error.code === "EADDRINUSE" ? "hub already running" : error.message);
			process.exit(error.code === "EADDRINUSE" ? 0 : 1);
		});
	const stop = () => hub.close().then(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
