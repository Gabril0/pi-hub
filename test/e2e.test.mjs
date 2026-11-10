import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const hubDir = mkdtempSync(join(tmpdir(), "pi-hub-e2e-"));
process.env.PI_HUB_DIR = hubDir;
process.env.PI_HUB_PORT = String(4900 + Math.floor(Math.random() * 500));
process.env.PI_HUB_SILENT = "1";
process.env.PI_HUB_SESSION_ID = "e2e-agent";
process.env.PI_HUB_NO_AUTOSTART = "1";

const { createHub } = await import("../hub/server.mjs");
const { AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader, createAgentSession } = await import("@mariozechner/pi-coding-agent");
const { registerFauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@mariozechner/pi-ai");

const workdir = mkdtempSync(join(tmpdir(), "pi-hub-work-"));
const file = join(workdir, "notes.txt");
let hub;
let session;
let faux;
const mainScript = [];
const seenToolResults = [];

async function api(method, path, body) {
	const res = await fetch(`http://127.0.0.1:${process.env.PI_HUB_PORT}${path}`, {
		method,
		headers: { "content-type": "application/json", "x-hub-token": hub.humanToken },
		body: body ? JSON.stringify(body) : undefined,
	});
	return res.json();
}

async function waitFor(predicate, label, timeout = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await predicate().catch(() => undefined);
		if (value) return value;
		await new Promise((r) => setTimeout(r, 60));
	}
	throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
	hub = createHub({ port: Number(process.env.PI_HUB_PORT), stateFile: join(hubDir, "state.json"), silent: true });
	await hub.listen();

	faux = registerFauxProvider({ provider: "faux", tokensPerSecond: 100000 });
	faux.setResponses(
		Array.from({ length: 40 }, () => (context) => {
			const system = context.systemPrompt ?? "";
			if (system.includes("reviewer requested changes")) return fauxAssistantMessage(fauxText("NOTE: renamed greeting\n````\nhello\nplanet\n````"));
			if (system.includes("reviewing it in a diff viewer")) return fauxAssistantMessage(fauxText("It replaces world with there because you asked."));
			if (system.includes("Summarize what this coding agent")) return fauxAssistantMessage(fauxText("- summary bullet"));
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") seenToolResults.push(last.content.map((c) => c.text).join("\n"));
			const step = mainScript.shift();
			return step ? step() : fauxAssistantMessage(fauxText("done"));
		}),
	);

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("faux", "test-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const loader = new DefaultResourceLoader({ cwd: workdir, agentDir: hubDir, additionalExtensionPaths: [join(import.meta.dirname, "..", "extension", "index.ts")] });
	await loader.reload();
	({ session } = await createAgentSession({ cwd: workdir, agentDir: hubDir, model: faux.getModel(), authStorage, modelRegistry, resourceLoader: loader, sessionManager: SessionManager.inMemory() }));
	await session.bindExtensions?.({});
});

after(async () => {
	session?.dispose();
	faux?.unregister();
	await hub?.close();
});

function editCall(oldText, newText) {
	return () => fauxAssistantMessage(fauxToolCall("edit", { path: "notes.txt", edits: [{ oldText, newText }] }), { stopReason: "toolUse" });
}

test("registers the session with a color", async () => {
	const registered = await waitFor(async () => (await api("GET", "/api/state")).sessions.find((s) => s.id === "e2e-agent" && s.online), "registration");
	assert.ok(registered.color?.hex);
});

test("approving a partially edited review applies the reviewer's content", async () => {
	writeFileSync(file, "hello\nworld\n");
	mainScript.push(editCall("world", "there"));
	const run = session.prompt("change world");
	const review = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending"), "pending review");
	assert.equal(review.path, "notes.txt");
	const full = await api("GET", `/api/reviews/${review.id}`);
	assert.equal(full.review.revisions[0].content, "hello\nthere\n");
	await api("POST", `/api/reviews/${review.id}/decision`, { decision: "approve", content: "hello\nthere!\n" });
	await run;
	assert.equal(readFileSync(file, "utf8"), "hello\nthere!\n");
	const applied = await waitFor(async () => (await api("GET", `/api/reviews/${review.id}`)).review.applied, "applied flag");
	assert.equal(applied, true);
});

test("denying blocks the edit and sends feedback to the agent", async () => {
	writeFileSync(file, "hello\nworld\n");
	mainScript.push(editCall("hello", "bye"));
	const run = session.prompt("change hello");
	const review = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending"), "pending review");
	await api("POST", `/api/reviews/${review.id}/decision`, {
		decision: "deny",
		comment: "keep the greeting",
		lineComments: [{ side: "new", line: 1, text: "bye is rude", snippet: "bye" }],
	});
	await run;
	assert.equal(readFileSync(file, "utf8"), "hello\nworld\n");
	const feedback = seenToolResults.at(-1);
	assert.match(feedback, /keep the greeting/);
	assert.match(feedback, /bye is rude/);
});

test("ask and revise negotiate in place before approval", async () => {
	writeFileSync(file, "hello\nworld\n");
	mainScript.push(editCall("world", "there"));
	const run = session.prompt("change world again");
	const review = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending"), "pending review");
	await api("POST", `/api/reviews/${review.id}/ask`, { text: "why?" });
	await waitFor(async () => (await api("GET", `/api/reviews/${review.id}`)).review.chat.some((m) => m.role === "agent"), "agent answer");
	await api("POST", `/api/reviews/${review.id}/revise`, { text: "use planet instead" });
	const revised = await waitFor(async () => {
		const { review: r } = await api("GET", `/api/reviews/${review.id}`);
		return r.revisions.length === 2 && r.status === "pending" ? r : undefined;
	}, "revision");
	assert.equal(revised.revisions[1].content, "hello\nplanet\n");
	await api("POST", `/api/reviews/${review.id}/decision`, { decision: "approve" });
	await run;
	assert.equal(readFileSync(file, "utf8"), "hello\nplanet\n");
});

test("trust mode auto-approves without a pending review", async () => {
	writeFileSync(file, "hello\nworld\n");
	await api("POST", "/api/sessions/e2e-agent/trust", { mode: "auto" });
	mainScript.push(editCall("world", "auto"));
	await session.prompt("auto change");
	assert.equal(readFileSync(file, "utf8"), "hello\nauto\n");
	await api("POST", "/api/sessions/e2e-agent/trust", { mode: "review" });
});

test("progress, messages to human, and test output reach the hub", async () => {
	mainScript.push(() =>
		fauxAssistantMessage(
			[
				fauxToolCall("report_progress", { steps: [{ title: "plan", status: "done" }, { title: "build", status: "active" }], note: "building" }),
				fauxToolCall("hub_message", { to: "human", body: "need a decision on naming" }),
			],
			{ stopReason: "toolUse" },
		),
	);
	mainScript.push(() => fauxAssistantMessage(fauxToolCall("bash", { command: "node --test --test-reporter=tap ./nothing-here-ok.mjs || echo exit code 1" }), { stopReason: "toolUse" }));
	await session.prompt("work");
	const state = await waitFor(async () => {
		const s = await api("GET", "/api/state");
		return s.sessions.find((x) => x.id === "e2e-agent")?.progress && s.testRuns.length ? s : undefined;
	}, "progress + test run");
	assert.equal(state.sessions.find((x) => x.id === "e2e-agent").progress.steps.length, 2);
	assert.ok(state.inbox.some((i) => i.kind === "message" && /naming/.test(i.body)));
	assert.ok(state.results.length > 0);
});

test("human messages from the hub start a turn", async () => {
	const before = faux.state.callCount;
	await api("POST", "/api/sessions/e2e-agent/message", { text: "status?" });
	await waitFor(async () => faux.state.callCount > before && session.isStreaming === false, "turn from hub message");
	const userTexts = session.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")));
	assert.ok(userTexts.some((t) => t.includes("status?")));
});

test("a pending review survives a hub restart", async () => {
	writeFileSync(file, "hello\nworld\n");
	mainScript.push(editCall("world", "restart"));
	const run = session.prompt("change during restart");
	const first = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending"), "pending review");
	await hub.close();
	hub = createHub({ port: Number(process.env.PI_HUB_PORT), stateFile: join(hubDir, "state.json"), silent: true });
	await hub.listen();
	const second = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending" && r.id !== first.id), "re-requested review", 20000);
	await api("POST", `/api/reviews/${second.id}/decision`, { decision: "approve" });
	await run;
	assert.equal(readFileSync(file, "utf8"), "hello\nrestart\n");
});

test("approval notes and reviewer edits reach the agent", async () => {
	writeFileSync(file, "hello\nworld\n");
	mainScript.push(editCall("world", "notes"));
	const run = session.prompt("change with notes");
	const review = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending"), "pending review");
	await api("POST", `/api/reviews/${review.id}/decision`, { decision: "approve", comment: "ship it but add a test", content: "hello\nnotes!\n" });
	await run;
	assert.equal(readFileSync(file, "utf8"), "hello\nnotes!\n");
	const result = seenToolResults.at(-1);
	assert.match(result, /ship it but add a test/);
	assert.match(result, /differs from your proposal/);
});

test("a file changed while its review is open is not overwritten", async () => {
	writeFileSync(file, "hello\nworld\n");
	mainScript.push(() => fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "agent version\n" }), { stopReason: "toolUse" }));
	const run = session.prompt("overwrite");
	const review = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending"), "pending review");
	writeFileSync(file, "human edit meanwhile\n");
	await api("POST", `/api/reviews/${review.id}/decision`, { decision: "approve" });
	await run;
	assert.equal(readFileSync(file, "utf8"), "human edit meanwhile\n");
	assert.match(seenToolResults.at(-1), /changed on disk/);
});
