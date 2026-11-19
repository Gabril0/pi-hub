import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BriefRequest, loadKnowledgeBrief } from "../extension/knowledge-brief.ts";
import { canonicalPath } from "../hub/paths.mjs";

const fast = { timeoutMs: 20, retryDelayMs: 1 };
const note = { where: "src/a.ts", text: "remember this" };
const hang: BriefRequest = () => new Promise(() => {});

function linkedFolder() {
	const base = mkdtempSync(join(tmpdir(), "pi-hub-paths-"));
	const real = join(base, "real");
	const link = join(base, "link");
	mkdirSync(real);
	symlinkSync(real, link, "junction");
	return { real: realpathSync.native(real), link };
}

test("a slow first answer is retried instead of reading as no notes", async () => {
	const reports: string[] = [];
	let calls = 0;
	const request: BriefRequest = (_url, signal) => {
		calls++;
		return calls === 1 ? hang("", signal) : Promise.resolve({ text: "brief", notes: [note] });
	};
	assert.deepEqual(await loadKnowledgeBrief(request, "/repo", (text) => reports.push(text), fast), { text: "brief", notes: [note] });
	assert.equal(calls, 2);
	assert.deepEqual(reports, []);
});

test("a timed out attempt aborts its request", async () => {
	const signals: AbortSignal[] = [];
	await loadKnowledgeBrief((_url, signal) => (signals.push(signal), hang("", signal)), "/repo", () => {}, fast);
	assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
});

test("a brief that keeps failing is reported once and stays empty", async () => {
	const reports: string[] = [];
	let calls = 0;
	const request: BriefRequest = async () => {
		calls++;
		throw new Error("hub 500");
	};
	assert.deepEqual(await loadKnowledgeBrief(request, "/repo", (text) => reports.push(text), fast), { text: "", notes: [] });
	assert.equal(calls, 2);
	assert.deepEqual(reports, ["knowledge brief failed: hub 500"]);
});

test("the brief is requested for the real path behind a link", async () => {
	const { real, link } = linkedFolder();
	let asked = "";
	await loadKnowledgeBrief(async (url) => ((asked = url), {}), join(link, "new", "file.ts"), () => {}, fast);
	assert.equal(new URL(asked, "http://hub").searchParams.get("path"), join(real, "new", "file.ts"));
});

test("canonical paths resolve links and keep folders that do not exist yet", () => {
	const { real, link } = linkedFolder();
	assert.equal(canonicalPath(link), real);
	assert.equal(canonicalPath(join(link, "a", "b")), join(real, "a", "b"));
});
