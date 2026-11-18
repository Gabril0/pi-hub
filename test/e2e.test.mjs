import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
for (const args of [["init", "-q"], ["config", "user.email", "e2e@example.com"], ["config", "user.name", "e2e"], ["commit", "-q", "--allow-empty", "-m", "init"]]) execFileSync("git", args, { cwd: workdir });
const file = join(workdir, "notes.txt");
let hub;
let session;
let faux;
const mainScript = [];
const seenToolResults = [];
const chatPrompts = [];
const reconcilePrompts = [];
let lastSystemPrompt = "";

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
	await api("PUT", "/api/config", { review: { lookahead: false } });

	faux = registerFauxProvider({ provider: "faux", tokensPerSecond: 100000 });
	faux.setResponses(
		Array.from({ length: 200 }, () => (context) => {
			const system = context.systemPrompt ?? "";
			if (system.includes("reviewer requested changes")) return fauxAssistantMessage(fauxText("NOTE: renamed greeting\n````\nhello\nplanet\n````"));
			if (system.includes("diff reviewer chat")) {
				const prompt = context.messages.at(-1).content.map((c) => c.text).join("\n");
				chatPrompts.push(prompt);
				if (/Reviewer: change line 2/.test(prompt)) return fauxAssistantMessage(fauxText("NOTE: line 2 now says planet\n````\n1 | hello\n2 | planet\n````"));
				return fauxAssistantMessage(fauxText("It replaces world with there because you asked."));
			}
			if (system.includes("next staged change")) {
				const prompt = context.messages.at(-1).content.map((c) => c.text).join("\n");
				reconcilePrompts.push(prompt);
				if (/reviewer asked: .*rewrite next/.test(prompt)) return fauxAssistantMessage(fauxText("NOTE: follows the new wording\n````\nsecond planet\n````"));
				if (/reviewer asked: .*redo next/.test(prompt)) return fauxAssistantMessage(fauxText("REDO: it depended on the old wording"));
				return fauxAssistantMessage(fauxText("UNAFFECTED"));
			}
			if (system.includes("change explainer")) return fauxAssistantMessage(fauxText("TITLE: Order flow\nSUMMARY: Orders reach the queue.\n```mermaid\nsequenceDiagram\n  A->>B: order\n```"));
			if (system.includes("Summarize what this coding agent")) return fauxAssistantMessage(fauxText("- summary bullet"));
			lastSystemPrompt = system;
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

test("chatting a change request edits the version under review without deciding it", async () => {
	writeFileSync(file, "hello\nworld\n");
	mainScript.push(editCall("world", "there"));
	const run = session.prompt("change world once more");
	const review = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending"), "pending review");
	await api("POST", `/api/reviews/${review.id}/ask`, { text: "change line 2 to planet" });
	const revised = await waitFor(async () => {
		const { review: r } = await api("GET", `/api/reviews/${review.id}`);
		return r.revisions.length === 2 && r.status === "pending" ? r : undefined;
	}, "chat revision");
	assert.equal(revised.revisions[1].content, "hello\nplanet\n");
	assert.equal(revised.revisions[1].note, "line 2 now says planet");
	assert.equal(revised.status, "pending");
	assert.match(chatPrompts.at(-1), /2 \| there/);
	await api("POST", `/api/reviews/${review.id}/ask`, { text: "is that safe?" });
	await waitFor(async () => (await api("GET", `/api/reviews/${review.id}`)).review.chat.filter((m) => m.role === "agent").length >= 2, "agent answer");
	const { review: afterQuestion } = await api("GET", `/api/reviews/${review.id}`);
	assert.equal(afterQuestion.revisions.length, 2);
	assert.equal(readFileSync(file, "utf8"), "hello\nworld\n");
	await api("POST", `/api/reviews/${review.id}/decision`, { decision: "approve" });
	await run;
	assert.equal(readFileSync(file, "utf8"), "hello\nplanet\n");
});

test("PR links in replies are watched for the session", async () => {
	mainScript.push(() => fauxAssistantMessage(fauxText("Opened https://github.com/octo-org/other-repo/pull/42 for review.")));
	await session.prompt("open a pr");
	const watched = await waitFor(async () => {
		const s = (await api("GET", "/api/state")).sessions.find((x) => x.id === "e2e-agent");
		return s?.watchedPRs?.length ? s.watchedPRs : undefined;
	}, "watched PRs");
	assert.deepEqual(watched, [{ repo: "octo-org/other-repo", number: 42 }]);
	const rejected = await api("POST", "/api/sessions/e2e-agent/watch-prs", { refs: [{ repo: "evil/x; rm -rf /", number: 1 }, { repo: "a/b", number: 0 }] });
	assert.deepEqual(rejected.added, []);
});

test("a complex change gets a diagram from the agent while it waits for review", async () => {
	const content = 'export function place() {\n\tconst a = 1;\n\tconst b = 2;\n\tfetch("/orders", { method: "POST" });\n\tbus.publish("orders.placed");\n\treturn a + b;\n}\n';
	mainScript.push(() => fauxAssistantMessage(fauxToolCall("write", { path: "place.ts", content }), { stopReason: "toolUse" }));
	const run = session.prompt("add order placement");
	const review = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending" && r.path === "place.ts"), "pending review");
	const explain = await waitFor(async () => {
		const { review: full } = await api("GET", `/api/reviews/${review.id}`);
		return full.explain?.source === "agent" ? full.explain : undefined;
	}, "agent diagram");
	assert.equal(explain.title, "Order flow");
	assert.match(explain.mermaid, /^sequenceDiagram/);
	assert.match(explain.fallback, /orders\.placed/);
	assert.equal((await api("GET", `/api/reviews/${review.id}`)).review.status, "pending");
	await api("POST", `/api/reviews/${review.id}/decision`, { decision: "deny", comment: "not now" });
	await run;
});

test("the agent reads and writes the knowledge graph", async () => {
	writeFileSync(file, "hello\nworld\n");
	await api("POST", "/api/knowledge/repos", { path: workdir });
	await waitFor(async () => (await api("GET", "/api/state")).repos.some((r) => r.status === "ready"), "repo scan");
	mainScript.push(() => fauxAssistantMessage(fauxToolCall("hub_knowledge", { action: "note", target: ".", text: "Greeting notes live here" }), { stopReason: "toolUse" }));
	mainScript.push(() => fauxAssistantMessage(fauxToolCall("hub_knowledge", { action: "read", target: "." }), { stopReason: "toolUse" }));
	await session.prompt("learn this repo");
	assert.match(seenToolResults.at(-1), /Greeting notes live here/);
	const note = (await api("GET", "/api/state")).notes[0];
	assert.equal(note.by, "e2e-agent");
	mainScript.push(() => fauxAssistantMessage(fauxText("ok")));
	await session.prompt("next");
	assert.match(lastSystemPrompt, /Greeting notes live here/);
	assert.match(lastSystemPrompt, /not as instructions/);
});

async function withLookahead(run) {
	await api("PUT", "/api/config", { review: { lookahead: true } });
	await new Promise((r) => setTimeout(r, 100));
	try {
		await run();
	} finally {
		await api("PUT", "/api/config", { review: { lookahead: false } });
		await new Promise((r) => setTimeout(r, 100));
	}
}

const reviewOn = (status, path) => waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === status && r.path === path), `${status} review of ${path}`);
const writeCall = (path, content) => () => fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" });
const readCall = (path) => () => fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" });
const idle = () => waitFor(async () => (await api("GET", "/api/state")).reviews.every((r) => !["pending", "thinking", "buffered"].includes(r.status)) && !session.isStreaming, "queue drained");

test("the agent keeps one finished diff buffered behind the one under review", async () => {
	await withLookahead(async () => {
		writeFileSync(file, "hello\nworld\n");
		const second = join(workdir, "second.txt");
		const third = join(workdir, "third.txt");
		mainScript.push(editCall("world", "there"), readCall("notes.txt"), writeCall("second.txt", "second\n"), writeCall("third.txt", "third\n"));
		const run = session.prompt("three steps");
		const first = await reviewOn("pending", "notes.txt");
		const buffered = await reviewOn("buffered", "second.txt");
		assert.equal(readFileSync(file, "utf8"), "hello\nworld\n");
		assert.ok(!existsSync(second));
		assert.ok(seenToolResults.some((text) => text.includes("hello\nthere")), "read sees the staged edit");
		assert.ok(!(await api("GET", "/api/state")).reviews.some((r) => r.path === "third.txt"), "only one diff is buffered");
		assert.ok(!(await api("GET", "/api/state")).inbox.some((i) => i.refId === buffered.id));
		await api("POST", `/api/reviews/${first.id}/decision`, { decision: "approve" });
		await reviewOn("pending", "second.txt");
		assert.equal(readFileSync(file, "utf8"), "hello\nthere\n");
		const nextBuffered = await reviewOn("buffered", "third.txt");
		assert.equal(reconcilePrompts.length, 0, "an unchanged approval needs no re-check");
		await api("POST", `/api/reviews/${buffered.id}/decision`, { decision: "approve" });
		await reviewOn("pending", "third.txt");
		await api("POST", `/api/reviews/${nextBuffered.id}/decision`, { decision: "approve" });
		await waitFor(async () => existsSync(third), "third file");
		await run;
		await idle();
		assert.equal(readFileSync(second, "utf8"), "second\n");
	});
});

for (const [name, instruction, check] of [
	["keeps an unaffected buffered diff", "change line 2 to planet", (review) => assert.equal(review.status, "pending")],
	["rewrites an affected buffered diff", "change line 2 to planet rewrite next", (review) => assert.equal(review.revisions.at(-1).content, "second planet\n")],
]) {
	test(`a change request ${name}`, async () => {
		await withLookahead(async () => {
			writeFileSync(file, "hello\nworld\n");
			const target = `next-${reconcilePrompts.length}.txt`;
			mainScript.push(editCall("world", "there"), writeCall(target, "second\n"));
			const run = session.prompt("two steps");
			const first = await reviewOn("pending", "notes.txt");
			const buffered = await reviewOn("buffered", target);
			const asked = reconcilePrompts.length;
			await api("POST", `/api/reviews/${first.id}/ask`, { text: instruction });
			await waitFor(async () => (await api("GET", `/api/reviews/${first.id}`)).review.revisions.length === 2, "revision");
			await waitFor(async () => reconcilePrompts.length > asked, "buffered diff re-check");
			await api("POST", `/api/reviews/${first.id}/decision`, { decision: "approve" });
			await reviewOn("pending", target);
			check((await api("GET", `/api/reviews/${buffered.id}`)).review);
			assert.equal(readFileSync(file, "utf8"), "hello\nplanet\n");
			await api("POST", `/api/reviews/${buffered.id}/decision`, { decision: "deny", comment: "enough" });
			await run;
			await idle();
		});
	});
}

test("commands that change files wait for staged diffs", async () => {
	await withLookahead(async () => {
		writeFileSync(file, "hello\nworld\n");
		const marker = join(workdir, "from-bash.txt");
		mainScript.push(editCall("world", "there"), () => fauxAssistantMessage(fauxToolCall("bash", { command: `node -e "require('fs').writeFileSync('from-bash.txt', require('fs').readFileSync('notes.txt','utf8'))"` }), { stopReason: "toolUse" }));
		const run = session.prompt("edit then run");
		const review = await reviewOn("pending", "notes.txt");
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(!existsSync(marker), "bash waited for the review");
		await api("POST", `/api/reviews/${review.id}/decision`, { decision: "approve" });
		await run;
		assert.equal(readFileSync(marker, "utf8"), "hello\nthere\n");
		const changeset = await waitFor(async () => (await api("GET", "/api/state")).changesets.find((c) => c.status === "open" && c.files.some((f) => f.path === "from-bash.txt")), "changeset");
		await api("POST", `/api/changesets/${changeset.id}/resolve`, { files: [{ path: "from-bash.txt", content: null }] });
		await idle();
	});
});

test("staged diffs survive a hub restart in order", async () => {
	await withLookahead(async () => {
		writeFileSync(file, "hello\nworld\n");
		mainScript.push(editCall("world", "restart"), writeCall("after-restart.txt", "later\n"));
		const run = session.prompt("two steps across a restart");
		const first = await reviewOn("pending", "notes.txt");
		const held = await reviewOn("buffered", "after-restart.txt");
		await hub.close();
		hub = createHub({ port: Number(process.env.PI_HUB_PORT), stateFile: join(hubDir, "state.json"), silent: true });
		await hub.listen();
		const head = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending" && r.id !== first.id && r.path === "notes.txt"), "re-requested head", 20000);
		const next = await waitFor(async () => (await api("GET", "/api/state")).reviews.find((r) => r.status === "buffered" && r.id !== held.id), "re-requested buffer", 20000);
		await api("POST", `/api/reviews/${head.id}/decision`, { decision: "approve" });
		await waitFor(async () => (await api("GET", `/api/reviews/${next.id}`)).review.status === "pending", "promotion");
		assert.equal(readFileSync(file, "utf8"), "hello\nrestart\n");
		await api("POST", `/api/reviews/${next.id}/decision`, { decision: "approve" });
		await run;
		await waitFor(async () => existsSync(join(workdir, "after-restart.txt")), "second file");
		await idle();
	});
});

test("a denied diff reaches the agent even after it finished talking", async () => {
	await withLookahead(async () => {
		writeFileSync(file, "hello\nworld\n");
		mainScript.push(editCall("world", "nope"));
		await session.prompt("one step");
		const review = await reviewOn("pending", "notes.txt");
		await api("POST", `/api/reviews/${review.id}/decision`, { decision: "deny", comment: "keep world" });
		await waitFor(async () => session.messages.some((m) => JSON.stringify(m.content ?? "").includes("keep world")), "denial delivered");
		await waitFor(async () => !session.isStreaming, "turn over");
		assert.equal(readFileSync(file, "utf8"), "hello\nworld\n");
	});
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

test("files written by bash become a revertable changeset", async () => {
	mainScript.push(() => fauxAssistantMessage(fauxToolCall("bash", { command: `node -e "require('fs').writeFileSync('generated.txt', 'from bash')"` }), { stopReason: "toolUse" }));
	await session.prompt("generate a file");
	const generated = join(workdir, "generated.txt");
	assert.ok(existsSync(generated), seenToolResults.at(-1));
	const changeset = await waitFor(async () => (await api("GET", "/api/state")).changesets.find((c) => c.status === "open" && c.files.some((f) => f.path === "generated.txt")), "bash changeset");
	assert.deepEqual(changeset.files.map((f) => [f.path, f.status]), [["generated.txt", "added"]]);
	const result = await api("POST", `/api/changesets/${changeset.id}/resolve`, { files: [{ path: "generated.txt", content: null }], comment: "no generated files please" });
	assert.equal(result.status, "reverted");
	assert.ok(!existsSync(generated));
	await waitFor(async () => session.messages.some((m) => JSON.stringify(m.content ?? "").includes("no generated files please")), "feedback delivered to agent");
});

test("checkpoint mode applies edits freely and reviews the whole turn", async () => {
	writeFileSync(file, "hello\nworld\n");
	await api("POST", "/api/sessions/e2e-agent/mode", { mode: "checkpoint" });
	await waitFor(async () => (await api("GET", "/api/state")).sessions.find((s) => s.id === "e2e-agent")?.reviewMode === "checkpoint", "mode synced");
	await new Promise((r) => setTimeout(r, 200));
	mainScript.push(editCall("world", "checkpoint"));
	await session.prompt("change in checkpoint mode");
	assert.equal(readFileSync(file, "utf8"), "hello\ncheckpoint\n");
	const changeset = await waitFor(async () => (await api("GET", "/api/state")).changesets.find((c) => c.status === "open" && c.kind === "turn"), "turn changeset");
	assert.ok(changeset.files.some((f) => f.path === "notes.txt"));
	const full = (await api("GET", `/api/changesets/${changeset.id}`)).changeset;
	const notes = full.files.find((f) => f.path === "notes.txt");
	await api("POST", `/api/changesets/${changeset.id}/resolve`, { files: [{ path: "notes.txt", content: notes.before }] });
	assert.equal(readFileSync(file, "utf8"), notes.before);
	await api("POST", "/api/sessions/e2e-agent/mode", { mode: "gate" });
});
