import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";

const COMMAND_TIMEOUT_MS = 4000;
const MAX_PARENT_HOPS = 8;

function run(command, args) {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error && !stdout ? "" : String(stdout ?? "")));
	});
}

export function parseElapsed(value) {
	const match = String(value ?? "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!match) return undefined;
	const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
	return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export function parseProcessTable(output) {
	const rows = [];
	for (const line of String(output ?? "").split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
		if (!match) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), elapsed: parseElapsed(match[3]), command: match[4] });
	}
	return rows;
}

const RUNTIMES = /(^|\/)(node|nodejs|bun|deno|tsx)$/;
const PI_BINARY = /(^|\/)pi$/;
const PI_CLI_SCRIPT = /pi-coding-agent\/dist\/cli\.js$/;

export function isPiProcess(command) {
	const argv = String(command ?? "").trim().split(/\s+/);
	if (PI_BINARY.test(argv[0] ?? "")) return true;
	if (!RUNTIMES.test(argv[0] ?? "")) return false;
	const script = argv.slice(1).find((arg) => !arg.startsWith("-"));
	return Boolean(script) && (PI_BINARY.test(script) || PI_CLI_SCRIPT.test(script));
}

export function parseCwdOutput(output) {
	const cwds = new Map();
	let pid;
	for (const line of String(output ?? "").split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1).trim());
	}
	return cwds;
}

export function parsePaneTable(output) {
	const panes = new Map();
	for (const line of String(output ?? "").split("\n")) {
		const [pid, paneId, ...location] = line.trim().split(/\s+/);
		if (pid && paneId) panes.set(Number(pid), { paneId, location: location.join(" ") || undefined });
	}
	return panes;
}

export function paneFor(pid, parents, panes) {
	let current = pid;
	for (let hop = 0; hop <= MAX_PARENT_HOPS && current; hop++) {
		const pane = panes.get(current);
		if (pane) return pane;
		current = parents.get(current);
	}
	return undefined;
}

export function mergeDiscovered({ processes, cwds, panes, connectedPids = new Set(), now = Date.now() }) {
	const parents = new Map(processes.map((p) => [p.pid, p.ppid]));
	return processes
		.filter((p) => isPiProcess(p.command))
		.map((p) => {
			const pane = paneFor(p.pid, parents, panes);
			return {
				pid: p.pid,
				cwd: cwds.get(p.pid),
				tmuxPane: pane?.paneId,
				tmuxLocation: pane?.location,
				startedAt: p.elapsed === undefined ? undefined : now - p.elapsed * 1000,
				connected: connectedPids.has(p.pid),
			};
		});
}

async function readCwds(pids) {
	if (!pids.length) return new Map();
	if (process.platform === "linux") {
		const entries = await Promise.all(pids.map(async (pid) => [pid, await readlink(`/proc/${pid}/cwd`).catch(() => undefined)]));
		const found = new Map(entries.filter(([, cwd]) => cwd));
		if (found.size === pids.length) return found;
	}
	return parseCwdOutput(await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]));
}

export async function discoverPiProcesses(connectedPids = new Set()) {
	if (process.platform === "win32") return [];
	const processes = parseProcessTable(await run("ps", ["-A", "-o", "pid=,ppid=,etime=,command="]));
	const piPids = processes.filter((p) => isPiProcess(p.command)).map((p) => p.pid);
	if (!piPids.length) return [];
	const [cwds, paneOutput] = await Promise.all([readCwds(piPids), run("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{pane_id} #{session_name}:#{window_index}.#{pane_index}"])]);
	return mergeDiscovered({ processes, cwds, panes: parsePaneTable(paneOutput), connectedPids });
}
