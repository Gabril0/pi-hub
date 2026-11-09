const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text) {
	return String(text ?? "").replace(ANSI, "");
}

const TEST_COMMAND = /(^|[\s;&|(])(cargo\s+(test|nextest)|go\s+test|pytest|python3?\s+-m\s+pytest|npx\s+(vitest|jest)|vitest|jest|(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|bun\s+test|node\s+--test|deno\s+test|mix\s+test|rspec|dotnet\s+test|mvn\s+(-\S+\s+)*test|gradle\w*\s+test|make\s+test)/;

export function isTestCommand(command) {
	return TEST_COMMAND.test(String(command ?? ""));
}

export function detectFramework(command, output) {
	const cmd = String(command ?? "");
	if (/nextest/.test(cmd) || /^\s*(PASS|FAIL) \[\s*[\d.]+s\]/m.test(output)) return "nextest";
	if (/cargo\s+test/.test(cmd) || /^test result: /m.test(output)) return "cargo";
	if (/go\s+test/.test(cmd) || /^(--- (PASS|FAIL|SKIP)|ok\s+\S+\s+[\d.]+s|FAIL\s+\S+\s+[\d.]+s)/m.test(output)) return "go";
	if (/pytest/.test(cmd) || /^=+ .*(passed|failed|error).* in [\d.]+s/m.test(output)) return "pytest";
	if (/vitest/.test(cmd) || /^\s*Test Files\s+/m.test(output)) return "vitest";
	if (/jest/.test(cmd) || /^Tests:\s+/m.test(output)) return "jest";
	if (/node\s+--test/.test(cmd) || /^# (pass|fail) \d+/m.test(output)) return "node";
	return "generic";
}

function push(tests, name, status, extra = {}) {
	const existing = tests.find((t) => t.name === name);
	if (existing) Object.assign(existing, { status, ...extra });
	else tests.push({ name, status, ...extra });
}

function parseGoJson(lines, tests) {
	const outputs = new Map();
	let parsed = 0;
	for (const line of lines) {
		if (!line.startsWith("{")) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		parsed++;
		if (!event.Test) continue;
		const name = `${event.Package ? `${event.Package.split("/").pop()}/` : ""}${event.Test}`;
		if (event.Action === "output") outputs.set(name, (outputs.get(name) ?? "") + event.Output);
		if (["pass", "fail", "skip"].includes(event.Action)) {
			const status = event.Action === "pass" ? "passed" : event.Action === "fail" ? "failed" : "skipped";
			push(tests, name, status, { durationMs: Math.round((event.Elapsed ?? 0) * 1000), output: status === "failed" ? outputs.get(name) : undefined });
		}
	}
	return parsed > 0;
}

function parseGo(output, tests) {
	const lines = output.split("\n");
	if (parseGoJson(lines, tests) && tests.length) return;
	let current = null;
	const buffers = new Map();
	for (const line of lines) {
		const run = line.match(/^=== RUN\s+(\S+)/);
		if (run) {
			current = run[1];
			continue;
		}
		const done = line.match(/^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/);
		if (done) {
			const status = done[1] === "PASS" ? "passed" : done[1] === "FAIL" ? "failed" : "skipped";
			push(tests, done[2], status, { durationMs: Math.round(Number(done[3]) * 1000), output: status === "failed" ? buffers.get(done[2]) : undefined });
			continue;
		}
		if (current) buffers.set(current, `${buffers.get(current) ?? ""}${line}\n`);
	}
}

function parseCargo(output, tests) {
	const lines = output.split("\n");
	for (const line of lines) {
		const match = line.match(/^test (\S+) \.\.\. (ok|FAILED|ignored|bench)/);
		if (match) push(tests, match[1], match[2] === "ok" ? "passed" : match[2] === "FAILED" ? "failed" : "skipped");
	}
	const sections = output.split(/^---- (\S+) stdout ----$/m);
	for (let i = 1; i < sections.length; i += 2) {
		const body = sections[i + 1].split(/^(failures:|---- )/m)[0];
		const test = tests.find((t) => t.name === sections[i]);
		if (test) test.output = body.trim();
	}
}

function parseNextest(output, tests) {
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*(PASS|FAIL|SKIP|SIGSEGV|TIMEOUT|LEAK)\s+\[\s*([\d.]+)s\]\s+(.+?)\s*$/);
		if (match) push(tests, match[3], match[1] === "PASS" ? "passed" : match[1] === "SKIP" ? "skipped" : "failed", { durationMs: Math.round(Number(match[2]) * 1000) });
	}
	const sections = output.split(/^--- STD(?:OUT|ERR):\s+(.+?)\s+---$/m);
	for (let i = 1; i < sections.length; i += 2) {
		const test = tests.find((t) => t.name === sections[i].trim());
		if (test) test.output = `${test.output ?? ""}${sections[i + 1].split(/^\s*(PASS|FAIL) \[/m)[0]}`.trim();
	}
}

function parsePytest(output, tests) {
	for (const line of output.split("\n")) {
		const verbose = line.match(/^(\S+::\S+)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)/);
		if (verbose) {
			const status = verbose[2] === "PASSED" || verbose[2] === "XPASS" ? "passed" : verbose[2] === "SKIPPED" || verbose[2] === "XFAIL" ? "skipped" : "failed";
			push(tests, verbose[1], status);
			continue;
		}
		const short = line.match(/^(FAILED|ERROR) (\S+::\S+)(?: - (.*))?/);
		if (short) push(tests, short[2], "failed", { output: short[3] });
	}
	const blocks = output.split(/^_{3,} (.+?) _{3,}$/m);
	for (let i = 1; i < blocks.length; i += 2) {
		const title = blocks[i].trim();
		const test = tests.find((t) => t.name.endsWith(`::${title}`) || t.name.endsWith(title.replace(/\./g, "::")));
		if (test) test.output = blocks[i + 1].split(/^=+ /m)[0].trim();
	}
}

function parseJsLike(output, tests) {
	let file = "";
	let lastFailed = null;
	for (const line of output.split("\n")) {
		const fileLine = line.match(/^\s*(PASS|FAIL)\s+(\S+\.(?:[cm]?[jt]sx?))/);
		if (fileLine) {
			file = fileLine[2];
			continue;
		}
		const match = line.match(/^\s*(✓|√|✔|✕|×|✗|✘|↓|○|-)\s+(.+?)(?:\s+\(?(\d+(?:\.\d+)?)\s?m?s\)?)?\s*$/);
		if (match && !/^\d+ (passed|failed)/.test(match[2])) {
			const symbol = match[1];
			const status = "✓√✔".includes(symbol) ? "passed" : "↓○-".includes(symbol) ? "skipped" : "failed";
			if (symbol === "-" && !/skipped|todo/.test(line)) continue;
			const name = file && !match[2].includes(file) ? `${file} › ${match[2]}` : match[2];
			push(tests, name, status, { durationMs: match[3] ? Math.round(Number(match[3])) : undefined });
			if (status === "failed") lastFailed = tests.find((t) => t.name === name);
		}
		const tap = line.match(/^(not ok|ok) \d+ - (.+?)(\s+# SKIP.*)?$/);
		if (tap) push(tests, tap[2], tap[3] ? "skipped" : tap[1] === "ok" ? "passed" : "failed");
	}
	const failBlocks = output.split(/^\s*●\s+(.+)$/m);
	for (let i = 1; i < failBlocks.length; i += 2) {
		const title = failBlocks[i].trim().replace(/ › /g, " › ");
		const test = tests.find((t) => t.status === "failed" && title.endsWith(t.name.split(" › ").pop()));
		if (test && !test.output) test.output = failBlocks[i + 1].trim().slice(0, 4000);
	}
	return lastFailed;
}

function summaryFromOutput(framework, output) {
	const take = (regex) => {
		const match = output.match(regex);
		return match ? Number(match[1]) : undefined;
	};
	if (framework === "cargo") {
		const lines = [...output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
		if (lines.length) {
			const sum = lines.reduce((acc, m) => [acc[0] + Number(m[1]), acc[1] + Number(m[2]), acc[2] + Number(m[3])], [0, 0, 0]);
			return { passed: sum[0], failed: sum[1], skipped: sum[2] };
		}
	}
	if (framework === "pytest") {
		return { passed: take(/(\d+) passed/), failed: (take(/(\d+) failed/) ?? 0) + (take(/(\d+) errors?/) ?? 0), skipped: take(/(\d+) skipped/) };
	}
	if (framework === "jest") return { passed: take(/^Tests:.*?(\d+) passed/m), failed: take(/^Tests:.*?(\d+) failed/m), skipped: take(/^Tests:.*?(\d+) skipped/m) };
	if (framework === "vitest") return { passed: take(/^\s*Tests\s+.*?(\d+) passed/m), failed: take(/^\s*Tests\s+.*?(\d+) failed/m), skipped: take(/^\s*Tests\s+.*?(\d+) skipped/m) };
	if (framework === "node") return { passed: take(/^# pass (\d+)/m), failed: take(/^# fail (\d+)/m), skipped: take(/^# skipped (\d+)/m) };
	return {};
}

export function parseTestOutput(command, rawOutput, exitCode) {
	const output = stripAnsi(rawOutput).replace(/\r\n?/g, "\n");
	const framework = detectFramework(command, output);
	const tests = [];
	if (framework === "go") parseGo(output, tests);
	else if (framework === "cargo") parseCargo(output, tests);
	else if (framework === "nextest") parseNextest(output, tests);
	else if (framework === "pytest") parsePytest(output, tests);
	else parseJsLike(output, tests);

	const counted = {
		passed: tests.filter((t) => t.status === "passed").length,
		failed: tests.filter((t) => t.status === "failed").length,
		skipped: tests.filter((t) => t.status === "skipped").length,
	};
	const reported = summaryFromOutput(framework, output);
	const summary = {
		passed: Math.max(counted.passed, reported.passed ?? 0),
		failed: Math.max(counted.failed, reported.failed ?? 0),
		skipped: Math.max(counted.skipped, reported.skipped ?? 0),
	};
	summary.total = summary.passed + summary.failed + summary.skipped;
	let status = exitCode === 0 ? "passed" : "failed";
	if (exitCode === undefined || exitCode === null) status = summary.failed > 0 ? "failed" : "passed";
	if (summary.failed > 0) status = "failed";
	if (status === "failed" && summary.failed === 0 && summary.total > 0 && exitCode !== 0) status = "error";
	return { framework, tests, summary, status };
}

export function compareRuns(previous, current) {
	if (!previous) return { newFailures: [], fixed: [] };
	const before = new Map(previous.tests.map((t) => [t.name, t.status]));
	const newFailures = current.tests.filter((t) => t.status === "failed" && before.get(t.name) !== "failed").map((t) => t.name);
	const fixed = current.tests.filter((t) => t.status === "passed" && before.get(t.name) === "failed").map((t) => t.name);
	return { newFailures, fixed };
}

export function flakyTests(runs) {
	const history = new Map();
	for (const run of runs) {
		for (const test of run.tests ?? []) {
			const list = history.get(test.name) ?? [];
			list.push(test.status);
			history.set(test.name, list);
		}
	}
	const flaky = [];
	for (const [name, statuses] of history) {
		const relevant = statuses.filter((s) => s !== "skipped");
		let flips = 0;
		for (let i = 1; i < relevant.length; i++) if (relevant[i] !== relevant[i - 1]) flips++;
		if (flips >= 2) flaky.push(name);
	}
	return flaky;
}

export function defaultTestCommand(files) {
	const has = (name) => files.includes(name);
	if (has("Cargo.toml")) return "cargo test";
	if (has("go.mod")) return "go test ./... -v";
	if (has("package.json")) return "npm test";
	if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return "pytest -v";
	if (has("mix.exs")) return "mix test";
	if (has("Makefile")) return "make test";
	return "";
}
