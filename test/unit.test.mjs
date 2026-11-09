import assert from "node:assert/strict";
import { test } from "node:test";
import { pickColor, PALETTE } from "../hub/colors.mjs";
import { notifyCommand, windowsToastScript } from "../hub/notify.mjs";
import { globToRegExp, matchesAutoApprove } from "../hub/server.mjs";
import { spawnPlan } from "../hub/terminal.mjs";
import { compareRuns, flakyTests, isTestCommand, parseTestOutput } from "../hub/test-parsers.mjs";
import { summarizeChecks } from "../hub/github.mjs";

test("cargo output parses tests and failure bodies", () => {
	const out = "test a::ok_one ... ok\ntest a::bad ... FAILED\ntest a::skip ... ignored\n\nfailures:\n\n---- a::bad stdout ----\npanicked at x\n\nfailures:\n    a::bad\n\ntest result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured\n";
	const run = parseTestOutput("cargo test", out, 101);
	assert.equal(run.framework, "cargo");
	assert.deepEqual(run.summary, { passed: 1, failed: 1, skipped: 1, total: 3 });
	assert.match(run.tests.find((t) => t.name === "a::bad").output, /panicked/);
	assert.equal(run.status, "failed");
});

test("go -v and go -json parse", () => {
	const text = parseTestOutput("go test ./... -v", "=== RUN   TestA\n--- PASS: TestA (0.01s)\n=== RUN   TestB\n    b_test.go:9: boom\n--- FAIL: TestB (0.00s)\nFAIL\n", 1);
	assert.equal(text.summary.failed, 1);
	assert.match(text.tests.find((t) => t.name === "TestB").output, /boom/);
	const json = ['{"Action":"run","Package":"x/pkg","Test":"TestC"}', '{"Action":"pass","Package":"x/pkg","Test":"TestC","Elapsed":0.2}'].join("\n");
	const parsed = parseTestOutput("go test -json ./...", json, 0);
	assert.equal(parsed.tests[0].name, "pkg/TestC");
	assert.equal(parsed.tests[0].durationMs, 200);
});

test("pytest, jest and vitest parse", () => {
	const py = parseTestOutput("pytest -v", "tests/test_a.py::test_one PASSED [50%]\ntests/test_a.py::test_two FAILED [100%]\n==== 1 failed, 1 passed in 0.10s ====\n", 1);
	assert.deepEqual([py.summary.passed, py.summary.failed], [1, 1]);
	const jest = parseTestOutput("npx jest", "PASS src/a.test.ts\n  ✓ adds (3 ms)\nFAIL src/b.test.ts\n  ✕ subtracts (2 ms)\nTests:       1 failed, 1 passed, 2 total\n", 1);
	assert.deepEqual([jest.summary.passed, jest.summary.failed], [1, 1]);
	const vitest = parseTestOutput("npx vitest run", " ✓ src/a.test.ts > math > adds 2ms\n × src/a.test.ts > math > divides 1ms\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n", 1);
	assert.equal(vitest.framework, "vitest");
	assert.deepEqual([vitest.summary.passed, vitest.summary.failed], [1, 1]);
});

test("run comparison and flaky detection", () => {
	const a = { tests: [{ name: "x", status: "passed" }, { name: "y", status: "failed" }] };
	const b = { tests: [{ name: "x", status: "failed" }, { name: "y", status: "passed" }] };
	assert.deepEqual(compareRuns(a, b), { newFailures: ["x"], fixed: ["y"] });
	assert.deepEqual(flakyTests([a, b, a]), ["x", "y"]);
});

test("test command detection", () => {
	for (const cmd of ["cargo test -p x", "go test ./...", "npm test", "pnpm run test", "pytest -q", "cd a && npx vitest run", "cargo nextest run"]) assert.ok(isTestCommand(cmd), cmd);
	for (const cmd of ["cargo build", "git status", "echo test"]) assert.ok(!isTestCommand(cmd), cmd);
});

test("auto-approve globs", () => {
	assert.ok(globToRegExp("**/*.md").test("docs/a/b.md"));
	assert.ok(globToRegExp("**/*.md").test("README.md"));
	assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
	assert.ok(matchesAutoApprove([{ glob: "**/*.lock" }], { relPath: "Cargo.lock", absPath: "/r/Cargo.lock", tool: "edit" }));
	assert.equal(matchesAutoApprove([{ glob: "**/*.md", tool: "write" }], { relPath: "a.md", absPath: "/a.md", tool: "edit" }), undefined);
});

test("colors prefer unused palette entries", () => {
	const sessions = [{ id: "a", online: true, color: PALETTE[0] }, { id: "b", online: true, color: PALETTE[1] }];
	assert.equal(pickColor(sessions, "c").name, PALETTE[2].name);
	assert.equal(pickColor(sessions, "a").name, PALETTE[0].name);
});

test("notification commands per platform", () => {
	assert.equal(notifyCommand({ title: "t", body: "b" }, "linux")[0], "notify-send");
	const [cmd, args] = notifyCommand({ title: "t", body: "b", url: "http://x/?a=1&b=2" }, "win32");
	assert.equal(cmd, "powershell.exe");
	const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
	const xml = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], "base64").toString("utf8");
	assert.match(xml, /launch="http:\/\/x\/\?a=1&amp;b=2"/);
	const hostile = windowsToastScript("x’ + (Write-Host PWNED) + ’", "<b>", "", true);
	assert.doesNotMatch(hostile, /PWNED/);
});

test("spawn plans per platform", () => {
	assert.equal(spawnPlan({ cwd: "/r", prompt: "go" }, "linux", true).via, "tmux");
	assert.deepEqual(spawnPlan({ cwd: "/r", prompt: "go" }, "darwin", false).args.slice(0, 2), ["-na", "Ghostty"]);
	assert.equal(spawnPlan({ cwd: "C:\r", prompt: "a;b" }, "win32", false).command.length > 0, true);
});

test("github check rollup", () => {
	assert.equal(summarizeChecks([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]).overall, "passed");
	assert.equal(summarizeChecks([{ name: "ci", status: "IN_PROGRESS" }]).overall, "pending");
	assert.equal(summarizeChecks([{ context: "lint", state: "FAILURE" }]).overall, "failed");
});

test("hub survives malformed URLs and rejects cross-origin writes", async () => {
	const { createHub } = await import("../hub/server.mjs");
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const hub = createHub({ port: 0, stateFile: join(mkdtempSync(join(tmpdir(), "hub-sec-")), "state.json"), silent: true });
	const port = await hub.listen();
	const base = `http://127.0.0.1:${port}`;
	const bad = await fetch(`${base}/%`);
	assert.ok(bad.status >= 400);
	const badApi = await fetch(`${base}/api/reviews/%E0%A4%A`, { headers: { "x-hub-token": hub.token } });
	assert.equal(badApi.status, 400);
	assert.equal((await fetch(`${base}/api/health`)).status, 200);
	const noToken = await fetch(`${base}/api/state`);
	assert.equal(noToken.status, 401);
	const cross = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "x-hub-token": hub.token, origin: "http://127.0.0.1:5173", "content-type": "application/json" }, body: "{}" });
	assert.equal(cross.status, 403);
	const queryWrite = await fetch(`${base}/api/tasks?token=${hub.token}`, { method: "POST", body: "{}" });
	assert.equal(queryWrite.status, 401);
	const agent = { "x-hub-token": hub.token, "content-type": "application/json" };
	const human = { "x-hub-token": hub.humanToken, "content-type": "application/json" };
	await fetch(`${base}/api/sessions/register`, { method: "POST", headers: agent, body: JSON.stringify({ id: "s1", cwd: "/tmp" }) });
	const review = await (await fetch(`${base}/api/reviews`, { method: "POST", headers: agent, body: JSON.stringify({ sessionId: "s1", tool: "write", path: "a.txt", absPath: "/tmp/a.txt", oldContent: "", newContent: "x" }) })).json();
	const selfApprove = await fetch(`${base}/api/reviews/${review.id}/decision`, { method: "POST", headers: agent, body: JSON.stringify({ decision: "approve" }) });
	assert.equal(selfApprove.status, 403);
	for (const [path, body] of [["/api/sessions/s1/trust", { mode: "auto" }], ["/api/tests/run", { cwd: "/tmp", command: "echo pwned" }], ["/api/spawn", { cwd: "/tmp" }]]) {
		assert.equal((await fetch(`${base}${path}`, { method: "POST", headers: agent, body: JSON.stringify(body) })).status, 403, path);
	}
	assert.equal((await fetch(`${base}/api/config`, { method: "PUT", headers: agent, body: "{}" })).status, 403);
	assert.equal((await fetch(`${base}/api/state`, { headers: agent })).status, 403);
	assert.equal((await fetch(`${base}/api/reviews/${review.id}/decision`, { method: "POST", headers: human, body: JSON.stringify({ decision: "approve" }) })).status, 200);
	const { request } = await import("node:http");
	const rebound = await new Promise((resolve) => request({ host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode)).end());
	assert.equal(rebound, 421);
	await hub.close();
});
