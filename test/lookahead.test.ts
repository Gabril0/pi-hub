import assert from "node:assert/strict";
import { test } from "node:test";
import { rebaseChange, restoreFormat } from "../extension/edits.ts";
import { type Reconcile, type StagedDecision, type StagedEntry, StagedQueue } from "../extension/lookahead.ts";

const ctx = {} as any;
const tick = async (check: () => boolean) => {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 2));
	}
	assert.fail("timed out");
};

function harness(reconcile: () => Promise<Reconcile> = async () => ({ kind: "unaffected" })) {
	const disk = new Map<string, string>([["a.txt", "one\ntwo\n"], ["b.txt", "bee\n"]]);
	const log: string[] = [];
	const decide = new Map<string, (d: StagedDecision) => void>();
	const revisions: any[] = [];
	const reconciled: any[] = [];
	let count = 0;
	const queue = new StagedQueue({
		create: async (entry: StagedEntry) => {
			const id = `r${++count}`;
			log.push(`create ${id} ${entry.held ? "held" : "visible"}`);
			return { id, status: "pending" };
		},
		wait: (entry) => new Promise((resolve) => decide.set(entry.id, resolve)),
		promote: async (id) => log.push(`promote ${id}`),
		revise: async (id, change) => revisions.push({ id, ...change }),
		cancel: async (entry, reason) => log.push(`cancel ${entry.id} ${reason}`),
		applied: async (id, ok) => log.push(`applied ${id} ${ok}`),
		reconcile: async (request) => {
			reconciled.push(request);
			return reconcile();
		},
		readDisk: (path) => disk.get(path) ?? null,
		writeDisk: (path, raw) => void disk.set(path, raw),
		display: (_tool, raw) => raw,
		restore: restoreFormat,
		rebase: rebaseChange,
		denialNote: (path) => `denied ${path}`,
		approvalNote: (path, _d, modified) => (modified ? `modified ${path}` : undefined),
	});
	const stage = (absPath: string, content: string, readBase?: string) => queue.stage({ toolCallId: `t-${absPath}`, tool: "edit", path: absPath, absPath, content, readBase, ctx });
	return { queue, disk, log, decide, revisions, reconciled, stage };
}

test("one diff is visible, one is buffered and the third step waits", async () => {
	const h = harness();
	await h.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await h.stage("a.txt", "ONE\nTWO\n", "one\nTWO\n");
	assert.equal(h.queue.read("a.txt"), "ONE\nTWO\n");
	assert.equal(h.disk.get("a.txt"), "one\ntwo\n");
	let thirdDone = false;
	const third = h.stage("b.txt", "BEE\n", "bee\n").then(() => (thirdDone = true));
	await new Promise((r) => setTimeout(r, 15));
	assert.equal(thirdDone, false);
	h.decide.get("r1")!({ decision: "approved" });
	await third;
	await tick(() => h.log.includes("promote r2"));
	assert.equal(h.disk.get("a.txt"), "one\nTWO\n");
	assert.deepEqual(h.log.slice(0, 2), ["create r1 visible", "create r2 held"]);
	assert.equal(h.reconciled.length, 0);
	assert.ok(h.log.includes("create r3 held"));
	h.decide.get("r2")!({ decision: "approved" });
	await tick(() => h.log.includes("promote r3"));
	h.decide.get("r3")!({ decision: "approved" });
	await h.queue.drained();
	assert.equal(h.disk.get("a.txt"), "ONE\nTWO\n");
	assert.equal(h.disk.get("b.txt"), "BEE\n");
});

test("a revision leaves an unaffected buffered diff alone after checking it", async () => {
	const h = harness();
	await h.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await h.stage("b.txt", "BEE\n", "bee\n");
	h.queue.headChanged("r1", "one\n2\n", "use a digit", "now a digit");
	await tick(() => h.reconciled.length === 1);
	assert.equal(h.reconciled[0].why, "use a digit");
	assert.equal(h.reconciled[0].conflict, false);
	h.decide.get("r1")!({ decision: "approved", content: "one\n2\n" });
	await tick(() => h.log.includes("promote r2"));
	assert.equal(h.reconciled.length, 1);
	assert.equal(h.revisions.length, 0);
	assert.equal(h.disk.get("a.txt"), "one\n2\n");
	assert.match(h.queue.takeNotes().join(" "), /revised: now a digit/);
});

test("a buffered diff in the same file is carried onto the revision", async () => {
	const h = harness();
	await h.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await h.stage("a.txt", "ONE\nTWO\n", "one\nTWO\n");
	h.queue.headChanged("r1", "one\n2\n", "use a digit");
	await tick(() => h.revisions.length === 1);
	assert.deepEqual(h.revisions[0], { id: "r2", content: "ONE\n2\n", oldContent: "one\n2\n", note: "Updated to sit on top of the reviewed a.txt." });
	assert.equal(h.queue.read("a.txt"), "ONE\n2\n");
	h.decide.get("r1")!({ decision: "approved", content: "one\n2\n" });
	await tick(() => h.log.includes("promote r2"));
	h.decide.get("r2")!({ decision: "approved" });
	await h.queue.drained();
	assert.equal(h.disk.get("a.txt"), "ONE\n2\n");
});

test("the model can rewrite or throw away an affected buffered diff", async () => {
	const rewritten = harness(async () => ({ kind: "revised", note: "uses the new name", content: "BUZZ\n" }));
	await rewritten.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await rewritten.stage("b.txt", "BEE\n", "bee\n");
	rewritten.queue.headChanged("r1", "one\n2\n", "rename");
	await tick(() => rewritten.revisions.length === 1);
	assert.equal(rewritten.revisions[0].content, "BUZZ\n");
	assert.equal(rewritten.queue.read("b.txt"), "BUZZ\n");

	const dropped = harness(async () => ({ kind: "redo", reason: "the helper it calls is gone" }));
	await dropped.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await dropped.stage("b.txt", "BEE\n", "bee\n");
	dropped.queue.headChanged("r1", "one\n2\n", "remove the helper");
	await tick(() => dropped.log.some((line) => line.startsWith("cancel r2")));
	assert.equal(dropped.queue.size, 1);
	assert.equal(dropped.queue.read("b.txt"), undefined);
	assert.match(dropped.queue.takeNotes().join(" "), /discarded because the helper it calls is gone/);
});

test("denying the visible diff re-checks the buffer against the original file", async () => {
	const h = harness();
	await h.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await h.stage("a.txt", "ONE\nTWO\n", "one\nTWO\n");
	h.decide.get("r1")!({ decision: "denied", comment: "no" });
	await tick(() => h.log.includes("promote r2"));
	assert.equal(h.disk.get("a.txt"), "one\ntwo\n");
	assert.equal(h.revisions[0].content, "ONE\ntwo\n");
	assert.match(h.reconciled[0].why, /denied it: no/);
	assert.ok(h.queue.takeNotes().includes("denied a.txt"));
});

test("overlapping buffered edits are dropped when the base moved under them", async () => {
	const h = harness();
	await h.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await h.stage("a.txt", "one\nTWO!\n", "one\nTWO\n");
	h.decide.get("r1")!({ decision: "denied" });
	await tick(() => h.log.some((line) => line.startsWith("cancel r2")));
	await h.queue.drained();
	assert.equal(h.disk.get("a.txt"), "one\ntwo\n");
});

test("a file changed on disk is not overwritten", async () => {
	const h = harness();
	await h.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	h.disk.set("a.txt", "human\n");
	h.decide.get("r1")!({ decision: "approved" });
	await h.queue.drained();
	assert.equal(h.disk.get("a.txt"), "human\n");
	assert.ok(h.log.includes("applied r1 false"));
	assert.match(h.queue.takeNotes()[0], /changed on disk/);
});

test("cancelling drops everything staged behind it", async () => {
	const h = harness();
	await h.stage("a.txt", "one\nTWO\n", "one\ntwo\n");
	await h.stage("b.txt", "BEE\n", "bee\n");
	h.decide.get("r1")!({ decision: "cancelled" });
	await h.queue.drained();
	assert.equal(h.disk.get("a.txt"), "one\ntwo\n");
	assert.equal(h.disk.get("b.txt"), "bee\n");
});

test("line endings and BOM survive reviewer edits", () => {
	assert.equal(restoreFormat("a\nb\n", "﻿x\r\ny\r\n"), "﻿a\r\nb\r\n");
	assert.equal(restoreFormat("a\n", null), "a\n");
	assert.equal(rebaseChange("a\nb\nc\n", "a\nB\nc\n", "A\nb\nc\n"), "A\nB\nc\n");
	assert.equal(rebaseChange("a\nb\n", "a\nB\n", "a\nz\n"), undefined);
});
