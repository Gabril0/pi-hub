import assert from "node:assert/strict";
import { test } from "node:test";
import { isPiProcess, mergeDiscovered, paneFor, parseCwdOutput, parseElapsed, parsePaneTable, parseProcessTable } from "../hub/discovery.mjs";

test("parseElapsed converts BSD and procps etime", () => {
	assert.equal(parseElapsed("05:12"), 312);
	assert.equal(parseElapsed("01:00:00"), 3600);
	assert.equal(parseElapsed("07-18:34:43"), ((7 * 24 + 18) * 60 + 34) * 60 + 43);
	assert.equal(parseElapsed("garbage"), undefined);
});

test("parseProcessTable reads pid, ppid, etime and the full command", () => {
	const rows = parseProcessTable("  101     1    10:00 /bin/zsh -l\n  202   101    02:03 node /usr/local/bin/pi --model x\n\nbad line\n");
	assert.deepEqual(rows, [
		{ pid: 101, ppid: 1, elapsed: 600, command: "/bin/zsh -l" },
		{ pid: 202, ppid: 101, elapsed: 123, command: "node /usr/local/bin/pi --model x" },
	]);
});

test("isPiProcess matches pi and node-launched pi but not lookalikes", () => {
	assert.equal(isPiProcess("pi"), true);
	assert.equal(isPiProcess("/opt/homebrew/bin/pi --continue"), true);
	assert.equal(isPiProcess("node /usr/local/bin/pi"), true);
	assert.equal(isPiProcess("/usr/bin/node --no-warnings /x/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"), true);
	assert.equal(isPiProcess("python3 pi.py"), false);
	assert.equal(isPiProcess("pip install x"), false);
	assert.equal(isPiProcess("/usr/bin/pi.py"), false);
	assert.equal(isPiProcess("node server.js pi"), false);
});

test("parseCwdOutput maps lsof field output to cwds", () => {
	const cwds = parseCwdOutput("p202\nfcwd\nn/home/dev/code/api\np303\nfcwd\nn/home/dev/code/web\n");
	assert.equal(cwds.get(202), "/home/dev/code/api");
	assert.equal(cwds.get(303), "/home/dev/code/web");
});

test("paneFor walks parent pids up to the tmux pane shell", () => {
	const panes = parsePaneTable("101 %3 work:1.0\n900 %7 other:2.1\n");
	const parents = new Map([[202, 150], [150, 101], [101, 1]]);
	assert.deepEqual(paneFor(202, parents, panes), { paneId: "%3", location: "work:1.0" });
	assert.equal(paneFor(555, new Map([[555, 1]]), panes), undefined);
});

test("mergeDiscovered returns pi processes with connection flags", () => {
	const processes = parseProcessTable("101 1 10:00 -zsh\n202 101 01:00 node /usr/local/bin/pi\n303 1 00:30 pi\n404 1 00:30 vim\n");
	const result = mergeDiscovered({ processes, cwds: new Map([[202, "/code/api"], [303, "/code/web"]]), panes: parsePaneTable("101 %3 work:1.0"), connectedPids: new Set([303]), now: 1_000_000 });
	assert.deepEqual(result, [
		{ pid: 202, cwd: "/code/api", tmuxPane: "%3", tmuxLocation: "work:1.0", startedAt: 940_000, connected: false },
		{ pid: 303, cwd: "/code/web", tmuxPane: undefined, tmuxLocation: undefined, startedAt: 970_000, connected: true },
	]);
});
