import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, test } from "node:test";

const hubDir = mkdtempSync(join(tmpdir(), "pi-hub-knowledge-"));
process.env.PI_HUB_DIR = hubDir;
process.env.PI_HUB_SILENT = "1";

const { extractFacts, isScannablePath, normalizeRoute, parseCallTarget, resolveImports, scanRepo } = await import("../hub/knowledge-scan.mjs");
const { ROOT_ID, buildModel, resolveTarget, viewGraph } = await import("../hub/knowledge-graph.mjs");
const { changeComplexity, changeDiagram, cleanMermaid } = await import("../hub/change-diagram.mjs");
const { createHub } = await import("../hub/server.mjs");
const { layoutGraph, NODE_HEIGHT, NODE_WIDTH } = await import("../web/lib/graph-layout.js");

const workspace = mkdtempSync(join(tmpdir(), "pi-hub-repos-"));
const REPOS = {
	web: {
		"package.json": JSON.stringify({ name: "web", dependencies: { "@acme/sdk": "1.0.0" } }),
		"src/api/orders.ts": 'import { retry } from "@acme/sdk";\nexport const load = (id) => retry(() => fetch(`/api/orders/${id}`));\nexport const create = () => fetch("/orders", { method: "POST" });\n',
		"src/pages/cart.ts": 'import { load, create } from "../api/orders.js";\nexport const cart = [load, create];\n',
		"src/orders.test.ts": 'fetch("/test-only");\n',
		".env.local": "ORDERS_API_URL=https://user:secret@orders.internal\n",
	},
	"orders-api": {
		"Cargo.toml": '[package]\nname = "orders-api"\n',
		"src/main.rs": "mod routes;\nmod events;\nfn main() {}\n",
		"src/routes.rs": 'use crate::events::order_created;\npub fn serve() {\n    Router::new().route("/orders", post(create)).route("/orders/:id", get(show));\n}\n',
		"src/events.rs": 'pub fn order_created() {\n    bus.publish("orders.created");\n    connect("postgres://db/orders");\n}\n',
	},
	billing: {
		"consumer.py": 'def run(bus):\n    bus.subscribe("orders.created")\n    requests.post("https://api.stripe.com/v1/charges")\n',
	},
	sdk: {
		"package.json": JSON.stringify({ name: "@acme/sdk" }),
		"src/index.ts": "export function retry(run) {\n\treturn run();\n}\n",
	},
};

let scans;
let model;

before(async () => {
	scans = [];
	for (const [name, files] of Object.entries(REPOS)) {
		for (const [path, content] of Object.entries(files)) {
			const target = join(workspace, name, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		scans.push({ ...(await scanRepo(join(workspace, name))), key: name });
	}
	model = buildModel({ repos: scans });
});

const edgeBetween = (view, fromLabel, toLabel, kind) => view.edges.find((edge) => edge.kind === kind && view.nodes.find((n) => n.id === edge.from)?.label === fromLabel && view.nodes.find((n) => n.id === edge.to)?.label === toLabel);

test("facts come from code, not comments, and tests do not count as traffic", () => {
	const facts = extractFacts("src/a.ts", '// fetch("/commented")\nimport x, { y as z, type T } from "./b";\nexport async function run() {\n\tawait fetch("/real", { method: "PUT" });\n}\n');
	assert.deepEqual(facts.calls.map((c) => `${c.method} ${c.path}`), ["PUT /real"]);
	assert.deepEqual(facts.imports[0].names, ["y", "T", "default"]);
	assert.deepEqual(facts.symbols.map((s) => [s.name, s.exported, s.line]), [["run", true, 3]]);
	assert.deepEqual(extractFacts("src/a.test.ts", 'fetch("/x")').calls, []);
});

test("routes are detected across frameworks with parameters normalized", () => {
	const paths = (file, text) => extractFacts(file, text).routes.map((r) => `${r.method} ${r.path}`);
	assert.deepEqual(paths("a.js", 'app.post("/users/:id/", h);'), ["POST /users/:p"]);
	assert.deepEqual(paths("a.py", '@app.get("/items/{item}")\ndef f(): pass\n'), ["GET /items/:p"]);
	assert.deepEqual(paths("a.rs", '.route("/x/:id", get(show))'), ["GET /x/:p"]);
	assert.deepEqual(paths("a.go", 'mux.HandleFunc("POST /jobs", h)'), ["POST /jobs"]);
	assert.equal(normalizeRoute("/a/${b}/c?d=1"), "/a/:p/c");
});

test("call targets never keep credentials and ignore localhost", () => {
	assert.deepEqual(parseCallTarget("https://user:secret@api.example.com/v1?key=abc"), { host: "api.example.com", path: "/v1", base: undefined });
	assert.equal(parseCallTarget("http://localhost:3000/x").host, undefined);
	assert.equal(parseCallTarget("${BASE_URL}/x").base, "BASE_URL");
	assert.equal(parseCallTarget("not-a-url"), undefined);
	assert.equal(parseCallTarget("https://hooks.example.com/services/T1/B2/abcdefghijklmnopqrstuvwx").path, "/services/T1/B2/:p");
});

test("secret files are never read and scans skip dependencies", () => {
	assert.equal(isScannablePath(".env.local"), false);
	assert.equal(isScannablePath("certs/server.key"), false);
	assert.equal(isScannablePath("node_modules/x/index.js"), false);
	assert.equal(isScannablePath("src/index.ts"), true);
	const dump = JSON.stringify(scans);
	assert.ok(!dump.includes("secret"));
});

test("imports resolve per language", () => {
	const files = new Set(["src/a.ts", "src/b.ts", "src/lib/mod.rs", "src/main.rs", "pkg/util.py", "pkg/__init__.py"]);
	const resolved = (path, text) => resolveImports(path, extractFacts(path, text), files);
	assert.equal(resolved("src/a.ts", 'import { b } from "./b.js";')[0].file, "src/b.ts");
	assert.equal(resolved("src/main.rs", "use crate::lib::thing;")[0].file, "src/lib/mod.rs");
	assert.equal(resolved("pkg/__init__.py", "from .util import run")[0].file, "pkg/util.py");
	assert.equal(resolved("src/a.ts", 'import x from "left-pad/sub";')[0].pkg, "left-pad");
});

test("the workspace level shows how repositories communicate", () => {
	const view = viewGraph(model, ROOT_ID);
	const http = edgeBetween(view, "web", "orders-api", "http");
	assert.ok(http, "web calls orders-api");
	assert.ok(http.details.includes("POST /orders"));
	assert.ok(edgeBetween(view, "web", "sdk", "package"));
	assert.ok(edgeBetween(view, "orders-api", "billing", "event").details.includes("orders.created"));
	assert.ok(edgeBetween(view, "orders-api", "postgres", "store"));
	assert.ok(edgeBetween(view, "billing", "api.stripe.com", "http"));
	assert.match(view.mermaid, /^flowchart LR/);
});

test("zooming goes repo, domain, file, symbol and keeps outside systems visible", () => {
	const repo = viewGraph(model, "repo:web");
	assert.deepEqual(repo.nodes.filter((n) => !n.ghost && !n.self).map((n) => n.label).sort(), ["api", "orders.test.ts", "pages"]);
	assert.ok(edgeBetween(repo, "pages", "api", "import"));
	const ghost = repo.nodes.find((n) => n.ghost && n.label === "orders-api");
	assert.ok(ghost, "the other repository appears as context");
	const domain = viewGraph(model, "dir:web:src/api");
	assert.deepEqual(domain.nodes.filter((n) => !n.ghost && !n.self).map((n) => n.label), ["orders.ts"]);
	assert.deepEqual(domain.crumbs.map((c) => c.label), ["Workspace", "web", "src/api"]);
	const file = viewGraph(model, "file:web:src/api/orders.ts");
	assert.deepEqual(file.nodes.filter((n) => n.kind === "symbol").map((n) => n.label).sort(), ["create", "load"]);
	assert.ok(file.edges.some((edge) => edge.to.endsWith("#load") && edge.kind === "import"));
});

test("targets resolve from paths, repo names and the workspace", () => {
	assert.equal(resolveTarget(model, "src/api", { repoKey: "web" }), "dir:web:src/api");
	assert.equal(resolveTarget(model, "orders-api/src/events.rs"), "file:orders-api:src/events.rs");
	assert.equal(resolveTarget(model, "SDK"), "repo:sdk");
	assert.equal(resolveTarget(model, "workspace"), ROOT_ID);
	assert.equal(resolveTarget(model, "nope/nothing"), undefined);
});

test("only complex changes ask for a diagram", () => {
	assert.equal(changeComplexity([{ path: "a.ts", before: "const a = 1;\n", after: "const a = 2;\n" }]).complex, false);
	const big = Array.from({ length: 70 }, (_, i) => `const v${i} = ${i};`).join("\n");
	assert.equal(changeComplexity([{ path: "a.ts", before: "", after: big }]).complex, true);
	assert.equal(changeComplexity([{ path: "README.md", before: "", after: big }]).complex, false);
	assert.equal(changeComplexity([{ path: "package-lock.json", before: "", after: big }]).complex, false);
	const wired = "const a = 1;\nconst b = 2;\nconst c = 3;\nawait fetch('/x');\nbus.publish('topic');\nconst d = 4;\n";
	const result = changeComplexity([{ path: "src/a.ts", before: "", after: wired }]);
	assert.equal(result.complex, true);
	assert.match(result.reasons[0], /new connection/);
});

test("the code-based diagram names routes, calls, events and existing callers", () => {
	const after = 'import { retry } from "@acme/sdk";\nexport const load = (id) => retry(() => fetch(`/api/orders/${id}`));\nexport const create = () => fetch("/orders", { method: "POST" });\napp.post("/hook", h);\nbus.publish("a.b");\nexport function extra() {}\n';
	const diagram = changeDiagram([{ path: "src/api/orders.ts", before: "", after }], { model, repoKey: "web" });
	assert.match(diagram.mermaid, /^flowchart LR/);
	assert.match(diagram.mermaid, /POST \/hook/);
	assert.match(diagram.mermaid, /a\.b/);
	assert.match(diagram.mermaid, /pages\/cart\.ts/);
	assert.match(diagram.mermaid, /orders-api/);
	assert.ok(cleanMermaid(diagram.mermaid));
});

test("agent diagrams are limited to safe Mermaid", () => {
	assert.equal(cleanMermaid("<script>alert(1)</script>"), undefined);
	assert.equal(cleanMermaid("pie\n a: 1"), undefined);
	const cleaned = cleanMermaid('%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n a-->b\n click a "javascript:alert(1)"\n');
	assert.equal(cleaned, "flowchart LR\n a-->b");
	assert.equal(cleanMermaid(`flowchart LR\n${"a-->b\n".repeat(5000)}`), undefined);
});

test("layout keeps nodes apart and flows left to right", () => {
	const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
	const edges = [["n0", "n1"], ["n1", "n2"], ["n2", "n0"], ["n0", "n3"], ["n3", "n4"], ["n5", "n4"], ["n1", "n6"]].map(([from, to]) => ({ id: `${from}|${to}`, from, to }));
	const layout = layoutGraph(nodes, edges);
	for (const a of layout.nodes) {
		assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
		for (const b of layout.nodes) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= NODE_WIDTH || Math.abs(a.y - b.y) >= NODE_HEIGHT, `${a.id} overlaps ${b.id}`);
	}
	const at = new Map(layout.nodes.map((n) => [n.id, n]));
	assert.ok(at.get("n3").x < at.get("n4").x);
	assert.ok(layout.edges.every((edge) => edge.path.startsWith("M") && !edge.path.includes("NaN")));
	assert.ok(at.get("n11").y >= Math.max(...["n0", "n1", "n2", "n3", "n4", "n5", "n6"].map((id) => at.get(id).y)));
});

test("context from outside a level sits beside it instead of stretching the chain", () => {
	const nodes = [{ id: "in", ghost: true }, { id: "a" }, { id: "b" }, { id: "out", ghost: true }, { id: "self", self: true }];
	const edges = [["in", "a"], ["a", "b"], ["b", "out"], ["out", "self"]].map(([from, to]) => ({ id: from + to, from, to }));
	const at = new Map(layoutGraph(nodes, edges).nodes.map((n) => [n.id, n]));
	assert.ok(at.get("in").x < at.get("a").x && at.get("a").x < at.get("b").x && at.get("b").x < at.get("out").x);
	assert.equal(at.get("out").x, at.get("self").x);
});

test("the hub scans, shares notes with agents and writes Markdown", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-hub-kg-"));
	const hub = createHub({ port: 0, stateFile: join(dir, "state.json"), silent: true, discover: () => [] });
	const port = await hub.listen();
	const call = async (token, method, path, body) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "x-hub-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, body: await res.json() };
	};
	const human = (...args) => call(hub.humanToken, ...args);
	const agent = (...args) => call(hub.token, ...args);
	try {
		assert.equal((await human("POST", "/api/knowledge/repos", { path: "relative/path" })).status, 400);
		assert.equal((await agent("POST", "/api/knowledge/repos", { path: workspace })).status, 403);
		assert.equal((await agent("GET", "/api/knowledge/view")).status, 403);
		for (const name of Object.keys(REPOS)) assert.equal((await human("POST", "/api/knowledge/repos", { path: join(workspace, name) })).status, 200);
		const deadline = Date.now() + 8000;
		while (hub.store.all("repos").some((r) => r.status !== "ready") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
		await agent("POST", "/api/sessions/register", { id: "a1", name: "orders", cwd: join(workspace, "orders-api"), repoRoot: join(workspace, "orders-api") });
		const note = await agent("POST", "/api/knowledge/notes", { sessionId: "a1", target: "src/events.rs", text: "Published after commit" });
		assert.equal(note.status, 200);
		assert.equal(note.body.note.byName, "orders");
		assert.equal((await agent("POST", "/api/knowledge/notes", { sessionId: "a1", target: "missing/file.rs", text: "x" })).status, 404);
		assert.equal((await agent("POST", "/api/knowledge/links", { sessionId: "a1", from: ".", to: "web", label: "serves the storefront" })).status, 200);
		const root = await human("GET", "/api/knowledge/view");
		assert.ok(root.body.edges.some((edge) => edge.kind === "link" && edge.details.includes("serves the storefront")));
		assert.equal(root.body.nodes.find((n) => n.label === "orders-api").notes, 1);
		assert.deepEqual(root.body.nodes.find((n) => n.label === "orders-api").agents, ["a1"]);
		const context = await agent("GET", "/api/knowledge/context?session=a1&target=.");
		assert.match(context.body.text, /Published after commit/);
		const brief = await agent("GET", `/api/knowledge/brief?path=${encodeURIComponent(join(workspace, "orders-api"))}`);
		assert.equal(brief.body.notes[0].where, "src/events.rs");
		assert.equal((await human("GET", "/api/knowledge/search?q=retry")).body.results[0].id, "file:" + hub.store.all("repos").find((r) => r.name === "sdk").id + ":src/index.ts");
		hub.knowledge.writeDocs();
		const key = hub.store.all("repos").find((r) => r.name === "orders-api").id;
		const doc = readFileSync(join(dir, "knowledge", `${key}.md`), "utf8");
		assert.match(doc, /# orders-api/);
		assert.match(doc, /POST \/orders/);
		assert.match(doc, /Published after commit/);
		assert.match(doc, /```mermaid/);
		assert.ok(existsSync(join(dir, "knowledge", "workspace.md")));
	} finally {
		await hub.close();
	}
	const reopened = createHub({ port: 0, stateFile: join(dir, "state.json"), silent: true, discover: () => [] });
	await reopened.listen();
	try {
		const restored = reopened.knowledge.view();
		assert.equal(restored.nodes.filter((n) => n.kind === "repo").length, 4);
		assert.equal(restored.nodes.find((n) => n.label === "orders-api").notes, 1);
	} finally {
		await reopened.close();
	}
});

test("complex reviews get a diagram from the code when the agent is away", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-hub-explain-"));
	const hub = createHub({ port: 0, stateFile: join(dir, "state.json"), silent: true, discover: () => [] });
	const port = await hub.listen();
	const call = async (token, method, path, body) => (await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "x-hub-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
	const wired = 'export function run() {\n\tconst a = 1;\n\tconst b = 2;\n\tfetch("/orders", { method: "POST" });\n\tbus.publish("orders.placed");\n\treturn a + b;\n}\n';
	try {
		await call(hub.token, "POST", "/api/sessions/register", { id: "s1", cwd: dir });
		const complex = await call(hub.token, "POST", "/api/reviews", { sessionId: "s1", tool: "write", path: "src/run.ts", absPath: join(dir, "src/run.ts"), isNew: true, oldContent: "", newContent: wired });
		const explain = hub.store.get("reviews", complex.id).explain;
		assert.equal(explain.status, "ready");
		assert.equal(explain.source, "code");
		assert.match(explain.mermaid, /orders\.placed/);
		const simple = await call(hub.token, "POST", "/api/reviews", { sessionId: "s1", tool: "edit", path: "a.ts", absPath: join(dir, "a.ts"), oldContent: "const a = 1;\n", newContent: "const a = 2;\n" });
		assert.equal(hub.store.get("reviews", simple.id).explain, undefined);
		const rejected = await fetch(`http://127.0.0.1:${port}/api/reviews/${complex.id}/diagram`, { method: "POST", headers: { "x-hub-token": hub.token, "content-type": "application/json" }, body: JSON.stringify({ mermaid: "<img src=x onerror=alert(1)>" }) });
		assert.equal(rejected.status, 400);
		assert.equal(hub.store.get("reviews", complex.id).explain.mermaid, explain.mermaid);
		await call(hub.token, "POST", `/api/reviews/${complex.id}/diagram`, { title: "T", summary: "S", mermaid: "sequenceDiagram\n A->>B: hi" });
		assert.equal(hub.store.get("reviews", complex.id).explain.source, "agent");
		assert.equal(hub.store.get("reviews", complex.id).explain.fallback, explain.mermaid);
		await call(hub.humanToken, "PUT", "/api/config", { review: { explainDiagrams: false } });
		const off = await call(hub.token, "POST", "/api/reviews", { sessionId: "s1", tool: "write", path: "src/other.ts", absPath: join(dir, "src/other.ts"), isNew: true, oldContent: "", newContent: wired });
		assert.equal(hub.store.get("reviews", off.id).explain, undefined);
		await call(hub.humanToken, "POST", `/api/reviews/${off.id}/explain`, {});
		assert.equal(hub.store.get("reviews", off.id).explain.status, "ready");
	} finally {
		await call(hub.humanToken, "PUT", "/api/config", { review: { explainDiagrams: true } });
		await hub.close();
	}
});
