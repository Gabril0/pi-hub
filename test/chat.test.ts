import assert from "node:assert/strict";
import { test } from "node:test";
import { numberLines, parseChatReply, stripLineNumbers } from "../extension/chat-reply.ts";

test("numberLines pads numbers to match the diff view", () => {
	const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
	const numbered = numberLines(text).split("\n");
	assert.equal(numbered.length, 10);
	assert.equal(numbered[0], " 1 | line1");
	assert.equal(numbered[9], "10 | line10");
});

test("stripLineNumbers only strips when every line is prefixed", () => {
	assert.equal(stripLineNumbers("1 | a\n2 | \n3 | c"), "a\n\nc");
	assert.equal(stripLineNumbers("const x = 1 | 2;\nfoo"), "const x = 1 | 2;\nfoo");
	assert.equal(stripLineNumbers("12 | x"), "x");
});

test("parseChatReply tells answers from in-place revisions", () => {
	const answer = parseChatReply("It is safe because `x` is checked first.\n\n```ts\nif (x) run();\n```", "a\n");
	assert.equal(answer.kind, "answer");
	const revision = parseChatReply("NOTE: renamed x to count\n````\n1 | let count = 0\n2 | count++\n````", "let x = 0\nx++\n");
	assert.deepEqual(revision, { kind: "revision", note: "renamed x to count", content: "let count = 0\ncount++\n" });
	const noFence = parseChatReply("NOTE: nothing to change, line 32 is already a match", "a\n");
	assert.equal(noFence.kind, "answer");
});
