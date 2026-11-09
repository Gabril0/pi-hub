import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, buildProposal, minimalEdits, resolveToolPath, rewriteInputForContent, unifiedDiff } from "../extension/edits.ts";

test("applyEdits handles multiple disjoint edits and rejects ambiguity", () => {
	assert.equal(applyEdits("a\nb\nc\n", [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }]), "A\nb\nC\n");
	assert.equal(applyEdits("x x", [{ oldText: "x", newText: "y" }]), undefined);
	assert.equal(applyEdits("a  \nb", [{ oldText: "a\nb", newText: "z" }]), "z");
});

test("buildProposal normalizes CRLF and BOM, and rewrite keeps a valid edit", () => {
	const dir = mkdtempSync(join(tmpdir(), "edits-"));
	writeFileSync(join(dir, "f.txt"), "﻿one\r\ntwo\r\n");
	const input: any = { path: "f.txt", edits: [{ oldText: "two", newText: "2" }] };
	const proposal = buildProposal("edit", input, dir)!;
	assert.equal(proposal.oldContent, "one\ntwo\n");
	assert.equal(proposal.newContent, "one\n2\n");
	rewriteInputForContent(proposal, input, "ONE\n2\n");
	assert.equal(applyEdits(proposal.editBase!, input.edits), "ONE\n2\n");
	const write = buildProposal("write", { path: "new.txt", content: "hi" }, dir)!;
	assert.equal(write.isNew, true);
});

test("unifiedDiff marks changed lines", () => {
	const diff = unifiedDiff("a\nb\nc", "a\nB\nc", "f");
	assert.match(diff, /-b\n\+B/);
});

test("minimalEdits produces small unique hunks that reproduce the target", () => {
	const base = `${Array.from({ length: 50 }, (_, i) => `line ${i % 5}`).join("\n")}\nunique tail\n`;
	const target = base.replace("unique tail", "changed tail").replace(/^line 0/, "first");
	const edits = minimalEdits(base, target)!;
	assert.ok(edits.length >= 1);
	assert.equal(applyEdits(base, edits), target);
	assert.ok(edits.every((e) => e.oldText.length < base.length));
	assert.equal(minimalEdits("same", "same"), undefined);
});

test("paths resolve like pi: tilde, at-prefix", () => {
	assert.equal(resolveToolPath("/tmp", "~/x.ts"), join(homedir(), "x.ts"));
	assert.equal(resolveToolPath(process.cwd(), "@a.ts"), join(process.cwd(), "a.ts"));
});

test("edits that cannot be previewed still produce a snippet review", () => {
	const dir = mkdtempSync(join(tmpdir(), "edits-"));
	writeFileSync(join(dir, "f.txt"), "alpha\n");
	const proposal = buildProposal("edit", { path: "f.txt", edits: [{ oldText: "missing", newText: "x" }] }, dir)!;
	assert.equal(proposal.snippetOnly, true);
	assert.match(proposal.newContent, /x/);
});

test("NFKC fuzzy matching matches what pi accepts", () => {
	assert.equal(applyEdits("const ﬁle = 1;\n", [{ oldText: "const file = 1;", newText: "const f = 2;" }]), "const f = 2;\n");
});
