import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_FILES = 60;
const MAX_BYTES = 400_000;
const READ_ONLY = /^\s*(ls|cat|head|tail|wc|grep|rg|find|fd|pwd|echo|which|type|tree|stat|du|df|env|printenv|date|whoami|git\s+(status|log|diff|show|branch|remote|rev-parse|blame|grep)|cargo\s+(check|clippy|tree|metadata)|go\s+(vet|list|env)|npm\s+(ls|view|outdated)|node\s+--version)\b[^>|;&]*$/;

export interface SnapshotFile {
	path: string;
	status: "added" | "modified" | "deleted";
	before: string | null;
	after: string | null;
	binary?: boolean;
	tooLarge?: boolean;
}

export interface Snapshot {
	root: string;
	tree: string;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, env: { ...process.env, ...env }, timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout));
	});
}

export function isReadOnlyCommand(command: string): boolean {
	return READ_ONLY.test(String(command ?? ""));
}

export async function takeSnapshot(cwd: string): Promise<Snapshot | undefined> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
	if (!root) return undefined;
	const indexPath = (await git(root, ["rev-parse", "--git-path", "index"]))?.trim();
	const dir = mkdtempSync(join(tmpdir(), "pi-hub-snap-"));
	const tempIndex = join(dir, "index");
	try {
		const realIndex = indexPath ? (isAbsolute(indexPath) ? indexPath : join(root, indexPath)) : undefined;
		if (realIndex && existsSync(realIndex)) copyFileSync(realIndex, tempIndex);
		const env = { GIT_INDEX_FILE: tempIndex };
		if ((await git(root, ["add", "-A"], env)) === undefined) return undefined;
		const tree = (await git(root, ["write-tree"], env))?.trim();
		return tree ? { root, tree } : undefined;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function blob(root: string, tree: string, path: string): Promise<string | null> {
	const out = await git(root, ["cat-file", "-p", `${tree}:${path}`]);
	return out ?? null;
}

export async function diffSnapshots(before: Snapshot, after: Snapshot): Promise<SnapshotFile[]> {
	if (before.root !== after.root || before.tree === after.tree) return [];
	const numstat = (await git(before.root, ["diff", "--numstat", "-z", "--no-renames", before.tree, after.tree])) ?? "";
	const binary = new Set<string>();
	for (const entry of numstat.split("\0")) {
		const match = entry.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
		if (match && match[1] === "-") binary.add(match[3]);
	}
	const names = ((await git(before.root, ["diff", "--name-status", "-z", "--no-renames", before.tree, after.tree])) ?? "").split("\0").filter(Boolean);
	const files: SnapshotFile[] = [];
	for (let i = 0; i + 1 < names.length && files.length < MAX_FILES; i += 2) {
		const code = names[i];
		const path = names[i + 1];
		const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
		if (binary.has(path)) {
			files.push({ path, status, before: null, after: null, binary: true });
			continue;
		}
		const beforeText = status === "added" ? null : await blob(before.root, before.tree, path);
		const afterText = status === "deleted" ? null : await blob(before.root, after.tree, path);
		const tooLarge = (beforeText?.length ?? 0) > MAX_BYTES || (afterText?.length ?? 0) > MAX_BYTES;
		files.push(tooLarge ? { path, status, before: null, after: null, tooLarge: true } : { path, status, before: beforeText, after: afterText });
	}
	return files;
}
