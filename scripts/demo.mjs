import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

process.env.PI_HUB_DIR ??= mkdtempSync(join(tmpdir(), "pi-hub-demo-"));
process.env.PI_HUB_PORT ??= "4810";
process.env.PI_HUB_SILENT ??= "1";

const { createHub } = await import("../hub/server.mjs");
const startedAt = Date.now();
const demoProcesses = () => [
	{ pid: 4242, cwd: "/home/dev/code/orders-api", tmuxPane: "%9", tmuxLocation: "work:2.1", startedAt: startedAt - 42 * 60 * 1000, connected: false },
	{ pid: 5151, cwd: "/home/dev/code/infra", tmuxPane: "%11", tmuxLocation: "ops:0.0", startedAt: startedAt - 3 * 3600 * 1000, connected: false },
];
const hub = createHub({ port: Number(process.env.PI_HUB_PORT), stateFile: join(process.env.PI_HUB_DIR, "state.json"), silent: true, openBrowserFn: () => {}, discover: demoProcesses });
await hub.listen();

const base = `http://127.0.0.1:${hub.port}`;
async function call(method, path, body) {
	const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "x-hub-token": hub.token }, body: body ? JSON.stringify(body) : undefined });
	return res.json();
}

const work = "/home/dev/code";
const sessions = [
	{ id: "demo-rust", name: "rust", repo: "tung-sahur", branch: "feat/parity-chant", model: "anthropic/claude-opus-5-5", tmuxPane: "%1" },
	{ id: "demo-api", name: "api", repo: "orders-api", branch: "chore/sdk-bump", model: "anthropic/claude-opus-5-5", tmuxPane: "%3" },
	{ id: "demo-web", name: "web", repo: "storefront-web", branch: "feat/discount-badge", model: "anthropic/claude-opus-5-5", tmuxPane: "%5" },
	{ id: "demo-web-2", name: "web", repo: "storefront-web", branch: "feat/discount-badge", model: "anthropic/claude-sonnet-5-5", tmuxPane: "%6" },
	{ id: "demo-sdk", name: "sdk", repo: "acme-sdk", branch: "main", model: "anthropic/claude-sonnet-5-5", tmuxPane: "%7" },
];
for (const [i, s] of sessions.entries()) {
	await call("POST", "/api/sessions/register", { ...s, cwd: posix.join(work, s.repo), pid: 1000 + i, platform: "linux" });
	await new Promise((r) => setTimeout(r, 3));
}
await call("POST", "/api/sessions/demo-web-2/events", {
	events: [
		{ kind: "agent_start", prompt: "Write vitest coverage for the discount badge while the other web agent implements it." },
		{ kind: "progress", steps: [{ title: "Read invoice.ts", status: "done" }, { title: "Write badge tests", status: "active" }] },
		{ kind: "usage", cost: 0.21, input: 18000, output: 1900, cacheRead: 60000 },
	],
});
await call("POST", "/api/sessions/demo-sdk/watch-prs", { refs: [{ repo: "acme/platform-infra", number: 318 }] });
const prBase = { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", createdAt: Date.now(), lastPolled: Date.now() };
hub.store.upsert("prs", { ...prBase, id: "pr_acme/orders-api#214", repo: "acme/orders-api", number: 214, title: "chore: bump acme_* crates to 4f2c9e1", url: "https://github.com/acme/orders-api/pull/214", reviewDecision: "REVIEW_REQUIRED", head: "chore/sdk-bump", base: "main", checks: [{ name: "cargo test", state: "passed" }, { name: "clippy", state: "pending" }], checksState: "pending", sessionId: "demo-api", sessionIds: ["demo-api"] });
hub.store.upsert("prs", { ...prBase, id: "pr_acme/platform-infra#318", repo: "acme/platform-infra", number: 318, title: "feat: enable sdk retries in staging", url: "https://github.com/acme/platform-infra/pull/318", reviewDecision: "APPROVED", head: "feat/staging-retries", base: "main", checks: [{ name: "terraform plan", state: "passed" }, { name: "policy", state: "passed" }], checksState: "passed", sessionId: "demo-sdk", sessionIds: ["demo-sdk"], watched: true });

await call("POST", "/api/sessions/demo-rust/events", {
	events: [
		{ kind: "agent_start", prompt: "Even numbers should say tung, odd numbers say sahur, and add a chant helper." },
		{ kind: "progress", steps: [{ title: "Rename parity output", status: "done" }, { title: "Add chant()", status: "active" }, { title: "cargo test", status: "pending" }] },
		{ kind: "usage", cost: 0.38, input: 31000, output: 2600, cacheRead: 120000 },
	],
});
await call("POST", "/api/sessions/demo-rust/state", { context: { tokens: 42000, contextWindow: 1000000, percent: 4.2 } });

const rustBefore = `fn parity(n: u32) -> &'static str {\n    if n % 2 == 0 {\n        "even"\n    } else {\n        "odd"\n    }\n}\n\nfn main() {\n    for n in 1..=8 {\n        println!("{n} is {}", parity(n));\n    }\n}\n`;
const rustAfter = `fn parity(n: u32) -> &'static str {\n    match n % 2 {\n        0 => "tung",\n        _ => "sahur",\n    }\n}\n\nfn chant(limit: u32) -> String {\n    (1..=limit).map(parity).collect::<Vec<_>>().join(" ")\n}\n\nfn main() {\n    for n in 1..=8 {\n        println!("{n} is {}", parity(n));\n    }\n    println!("{}", chant(4));\n}\n`;
const rustReview = await call("POST", "/api/reviews", { sessionId: "demo-rust", tool: "edit", path: "src/main.rs", absPath: posix.join(work, "tung-sahur", "src", "main.rs"), oldContent: rustBefore, newContent: rustAfter, intent: "Switching `parity` to a `match` so even numbers chant **tung** and odd ones **sahur**, then adding `chant(limit)` to join them." });
await call("POST", `/api/reviews/${rustReview.id}/chat`, { role: "user", text: "why switch the if/else to a match?" });
await call("POST", `/api/reviews/${rustReview.id}/chat`, { role: "agent", text: "`match n % 2` makes both arms explicit, so **0 → `tung`** and anything else → `sahur`. `chant(4)` then prints `sahur tung sahur tung`." });

await call("POST", "/api/sessions/demo-api/events", {
	events: [
		{ kind: "agent_start", prompt: "Bump every acme_* crate to the SDK release that adds request retries, then re-run the API tests." },
		{ kind: "tool_start", toolName: "bash", summary: "cargo tree -i acme_http" },
		{ kind: "assistant", text: "All eight acme_* crates point at older revs. I'll align them to 4f2c9e1 so cargo stops building duplicate copies." },
		{ kind: "progress", steps: [{ title: "Find current revs", status: "done" }, { title: "Bump Cargo.toml", status: "active" }, { title: "cargo check", status: "pending" }, { title: "Open PR", status: "pending" }], note: "waiting for review on Cargo.toml" },
		...Array.from({ length: 7 }, () => ({ kind: "turn_end" })),
		{ kind: "usage", cost: 3.42, input: 220000, output: 18000, cacheRead: 900000 },
	],
});
await call("POST", "/api/sessions/demo-web/events", {
	events: [
		{ kind: "agent_start", prompt: "Show a discount badge on invoices that have a coupon applied, and add tests for it." },
		{ kind: "progress", steps: [{ title: "Read invoice renderer", status: "done" }, { title: "Add discounted field", status: "done" }, { title: "Write tests", status: "active" }] },
		{ kind: "assistant", text: "Renderer now reads `discounted`. Writing table-driven tests next." },
		...Array.from({ length: 4 }, () => ({ kind: "turn_end" })),
		{ kind: "usage", cost: 1.18, input: 90000, output: 9000, cacheRead: 300000 },
	],
});
await call("POST", "/api/sessions/demo-sdk/events", {
	events: [
		{ kind: "agent_start", prompt: "Cut a release of acme-sdk with configurable request retries." },
		{ kind: "agent_end", text: "Released **4f2c9e1**.\n\n- retries behind `ACME_HTTP_RETRIES`\n- changelog updated\n\nMerge order: sdk #212 → api #318 → web #95." },
		{ kind: "summary", text: "- Goal: release the SDK with retries\n- Done: tagged 4f2c9e1, changelog\n- Next: api + web re-pin" },
		{ kind: "usage", cost: 0.74, input: 60000, output: 4000 },
	],
});
await call("POST", "/api/sessions/demo-api/state", { context: { tokens: 178000, contextWindow: 1000000, percent: 17.8 } });
await call("POST", "/api/sessions/demo-web/state", { context: { tokens: 412000, contextWindow: 1000000, percent: 41.2 } });

const crates = ["acme_auth", "acme_billing", "acme_core", "acme_db", "acme_events", "acme_http", "acme_metrics", "acme_tracing"];
const oldRevs = { 1: "7d0e2b6a91c4f38e5a2d7c1b9e6f40a3c8d5e217", 5: "c3a91f7e2b8d4065f1e9a7c2d3b5480e6f1a9c4d" };
const before = `[package]\nname = "orders-api"\nversion = "0.14.2"\nedition = "2021"\n\n[dependencies]\n${crates.map((c, i) => `${c} = { git = "ssh://git@github.com/acme/acme-sdk.git", rev = "${oldRevs[i] ?? "1b6f0d93e7a24c58b0f3e9d2a6c71e48f5b0d3a9"}" }`).join("\n")}\ntokio = { version = "1.40", features = ["full"] }\nserde = "1"\n`;
const after = before.replace(/rev = "[0-9a-f]+"/g, 'rev = "4f2c9e18a0b7d35e6c1f92a4b8e07d5c3a6f1e20"');
await call("POST", "/api/reviews", { sessionId: "demo-api", tool: "edit", path: "Cargo.toml", absPath: posix.join(work, "orders-api", "Cargo.toml"), oldContent: before, newContent: after, intent: "All eight acme_* crates point at older revs. I'll align them to 4f2c9e1 so cargo stops building duplicate copies." });

const tsBefore = `export interface Invoice {\n\tid: string;\n\tamount: number;\n\tcurrency: string;\n}\n\nexport function renderInvoice(i: Invoice): string {\n\tconst value = (i.amount / 100).toFixed(2);\n\treturn \`\${i.id}: \${value} \${i.currency}\`;\n}\n\nexport function renderAll(list: Invoice[]): string[] {\n\treturn list.map(renderInvoice);\n}\n`;
const tsAfter = `export interface Invoice {\n\tid: string;\n\tamount: number;\n\tcurrency: string;\n\tdiscounted?: boolean;\n}\n\nexport function renderInvoice(i: Invoice): string {\n\tconst value = (i.amount / 100).toFixed(2);\n\tconst badge = i.discounted ? " (discount)" : "";\n\treturn \`\${i.id}: \${value} \${i.currency}\${badge}\`;\n}\n\nexport function renderAll(list: Invoice[]): string[] {\n\treturn list.filter(Boolean).map(renderInvoice);\n}\n`;
const review2 = await call("POST", "/api/reviews", { sessionId: "demo-web", tool: "edit", path: "src/invoice.ts", absPath: posix.join(work, "storefront-web", "src", "invoice.ts"), oldContent: tsBefore, newContent: tsAfter, intent: "Adding an optional `discounted` flag and a badge suffix, and skipping `null` rows the API sends during refunds." });
await call("POST", `/api/reviews/${review2.id}/chat`, { role: "user", text: "why filter(Boolean)?" });
await call("POST", `/api/reviews/${review2.id}/chat`, { role: "agent", text: "The orders endpoint occasionally returns `null` rows while a **refund is processing**; `filter(Boolean)` drops them so `renderInvoice` never sees `undefined`." });

await call("POST", "/api/questions", { sessionId: "demo-web", question: "Should discounted invoices also show the original price struck through, or only the badge?", options: ["Badge only", "Show both", "Ask design"] });
await call("POST", "/api/messages", { from: "demo-sdk", to: "human", body: "sdk **4f2c9e1** is tagged. api and web can re-pin now." });

const cargoOut = `running 4 tests\ntest orders::tests::applies_discount ... ok\ntest retry::tests::retries ... ok\ntest retry::tests::backoff ... ok\ntest events::tests::drains ... ok\n\ntest result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n`;
await call("POST", "/api/tests/ingest", { sessionId: "demo-api", cwd: posix.join(work, "orders-api"), command: "cargo test", output: cargoOut, exitCode: 0 });
const vitestPass = ` ✓ src/invoice.test.ts > renderInvoice > renders amount 2ms\n ✓ src/invoice.test.ts > renderInvoice > skips null rows 1ms\n ✓ src/invoice.test.ts > renderInvoice > renders currency 1ms\n ✓ src/invoice.test.ts > renderInvoice > renders discount badge 3ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n`;
const vitestFail = vitestPass.replace(" ✓ src/invoice.test.ts > renderInvoice > renders discount badge 3ms", " × src/invoice.test.ts > renderInvoice > renders discount badge 3ms").replace("Test Files  1 passed (1)", "Test Files  1 failed (1)").replace("Tests  4 passed (4)", "Tests  1 failed | 3 passed (4)") + `\n FAIL  src/invoice.test.ts > renderInvoice > renders discount badge\nAssertionError: expected '42.00 USD' to be '42.00 USD (discount)'\n ❯ src/invoice.test.ts:31:42\n`;
await call("POST", "/api/tests/ingest", { sessionId: "demo-web", cwd: posix.join(work, "storefront-web"), command: "npx vitest run", output: vitestPass, exitCode: 0 });
await call("POST", "/api/tests/ingest", { sessionId: "demo-web", cwd: posix.join(work, "storefront-web"), command: "npx vitest run", output: vitestFail, exitCode: 1 });
await call("POST", "/api/changesets", {
	sessionId: "demo-web",
	kind: "bash",
	title: "npm run codegen && npm pkg set version=2.4.0",
	root: posix.join(work, "storefront-web"),
	files: [
		{ path: "src/gen/orders-client.ts", status: "added", before: null, after: "export interface Order {\n\tid: string;\n\ttotal: number;\n\tdiscounted?: boolean;\n}\n\nexport async function getOrder(id: string): Promise<Order> {\n\tconst res = await fetch(`/api/orders/${id}`);\n\treturn res.json();\n}\n" },
		{ path: "package.json", status: "modified", before: "{\n  \"name\": \"storefront-web\",\n  \"version\": \"2.3.1\",\n  \"private\": true\n}\n", after: "{\n  \"name\": \"storefront-web\",\n  \"version\": \"2.4.0\",\n  \"private\": true\n}\n" },
	],
});
await call("POST", "/api/tests/ingest", { sessionId: "demo-sdk", cwd: posix.join(work, "acme-sdk"), command: "go test ./... -v", output: "=== RUN   TestRetry\n--- PASS: TestRetry (0.02s)\n=== RUN   TestBackoff\n--- PASS: TestBackoff (0.11s)\nok  \tacme-sdk/retry\t0.140s\n", exitCode: 0 });

const t1 = await call("POST", "/api/tasks", { title: "Release SDK with retries", status: "done", owner: "demo-sdk" });
const t2 = await call("POST", "/api/tasks", { title: "Bump api to SDK 4f2c9e1", status: "doing", owner: "demo-api", deps: [t1.task.id] });
const t3 = await call("POST", "/api/tasks", { title: "Discount badge on invoices", status: "doing", owner: "demo-web", deps: [t1.task.id] });
await call("POST", "/api/tasks", { title: "Re-pin web to merged SDK rev", status: "todo", deps: [t2.task.id, t3.task.id] });
await call("POST", "/api/tasks", { title: "Enable retries in staging", status: "todo", deps: [t3.task.id] });

function scriptedChat(content, text) {
	const lines = content.split("\n");
	const lineEdit = text.match(/line\s+(\d+)\s+(?:to|into|so it says)\s+([\s\S]+)/i);
	if (lineEdit && Number(lineEdit[1]) >= 1 && Number(lineEdit[1]) <= lines.length) {
		const index = Number(lineEdit[1]) - 1;
		const indent = lines[index].match(/^\s*/)[0];
		const replacement = lineEdit[2].trim().replace(/^`+|`+$/g, "");
		lines[index] = indent + replacement.trimStart();
		return { content: lines.join("\n"), note: `Line ${index + 1} is now \`${replacement.trim()}\`.` };
	}
	const rename = text.match(/rename\s+`?(\w+)`?\s+to\s+`?(\w+)`?/i);
	if (rename && new RegExp(`\\b${rename[1]}\\b`).test(content)) {
		return { content: content.replace(new RegExp(`\\b${rename[1]}\\b`, "g"), rename[2]), note: `Renamed \`${rename[1]}\` to \`${rename[2]}\` everywhere in this file.` };
	}
	return { answer: "A `match` on `n % 2` lists both outcomes side by side, so adding a third chant later is one more arm instead of another `else if`." };
}

async function scriptedAgent(sessionId) {
	const res = await fetch(`${base}/api/sessions/${sessionId}/channel`, { headers: { "x-hub-token": hub.token } });
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of res.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let index;
		while ((index = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
			if (!data) continue;
			const message = JSON.parse(data);
			if (message.type !== "review_ask" && message.type !== "review_revise") continue;
			const { review } = await call("GET", `/api/reviews/${message.reviewId}`);
			const latest = review.revisions.at(-1).content;
			await new Promise((r) => setTimeout(r, 900));
			const reply = scriptedChat(latest, message.text);
			if (reply.content && reply.content !== latest) await call("POST", `/api/reviews/${message.reviewId}/revision`, { content: reply.content, note: reply.note });
			else await call("POST", `/api/reviews/${message.reviewId}/chat`, { role: "agent", text: reply.answer ?? "That line already says that, so there is nothing to change." });
		}
	}
}
for (const sessionId of ["demo-rust", "demo-web"]) scriptedAgent(sessionId).catch(() => {});

writeFileSync(join(process.env.PI_HUB_DIR, "demo-url.txt"), hub.url());
console.log(`demo hub: ${hub.url()}`);
