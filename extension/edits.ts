import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface TextEdit {
	oldText: string;
	newText: string;
}

export interface Proposal {
	tool: "edit" | "write";
	path: string;
	absPath: string;
	isNew: boolean;
	oldContent: string;
	newContent: string;
	editBase?: string;
	snippetOnly?: boolean;
	rawBefore: string | null;
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function resolveToolPath(cwd: string, rawPath: string): string {
	let cleaned = String(rawPath ?? "")
		.replace(/^@/, "")
		.replace(/[  -   　]/g, " ");
	if (cleaned === "~") cleaned = homedir();
	else if (cleaned.startsWith("~/")) cleaned = homedir() + cleaned.slice(1);
	return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

function fuzzyNormalize(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.replace(/[  -   　]/g, " ");
}

function locate(content: string, oldText: string): { index: number; length: number } | undefined {
	const first = content.indexOf(oldText);
	if (first === -1) return undefined;
	if (content.indexOf(oldText, first + 1) !== -1) return undefined;
	return { index: first, length: oldText.length };
}

export function applyEdits(content: string, edits: TextEdit[]): string | undefined {
	const normalizedEdits = edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) }));
	let base = content;
	let matches = normalizedEdits.map((e) => locate(base, e.oldText));
	if (matches.some((m) => !m)) {
		base = fuzzyNormalize(content);
		matches = normalizedEdits.map((e) => locate(base, fuzzyNormalize(e.oldText)));
		if (matches.some((m) => !m)) return undefined;
	}
	const ordered = matches.map((m, i) => ({ ...m!, newText: normalizedEdits[i].newText })).sort((a, b) => b.index - a.index);
	for (let i = 1; i < ordered.length; i++) {
		if (ordered[i].index + ordered[i].length > ordered[i - 1].index) return undefined;
	}
	let out = base;
	for (const m of ordered) out = out.slice(0, m.index) + m.newText + out.slice(m.index + m.length);
	return out;
}

export function normalizeEditInput(input: any): TextEdit[] {
	let edits = input?.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	const list: TextEdit[] = Array.isArray(edits) ? edits.filter((e) => typeof e?.oldText === "string" && typeof e?.newText === "string") : [];
	if (typeof input?.oldText === "string" && typeof input?.newText === "string") list.push({ oldText: input.oldText, newText: input.newText });
	return list;
}

export function buildProposal(toolName: string, input: any, cwd: string): Proposal | undefined {
	if (toolName !== "edit" && toolName !== "write") return undefined;
	if (typeof input?.path !== "string") return undefined;
	const absPath = resolveToolPath(cwd, input.path);
	const exists = existsSync(absPath);
	let raw = "";
	if (exists) {
		try {
			raw = readFileSync(absPath, "utf8");
		} catch {
			return undefined;
		}
	}
	if (toolName === "write") {
		if (typeof input.content !== "string") return undefined;
		return { tool: "write", path: input.path, absPath, isNew: !exists, oldContent: raw, newContent: input.content, rawBefore: exists ? raw : null };
	}
	const edits = normalizeEditInput(input);
	if (!exists || !edits.length) return undefined;
	const editBase = normalizeToLF(stripBom(raw));
	const newContent = applyEdits(editBase, edits);
	if (newContent === undefined) {
		return {
			tool: "edit",
			path: input.path,
			absPath,
			isNew: false,
			oldContent: edits.map((e) => normalizeToLF(e.oldText)).join("\n⋯\n"),
			newContent: edits.map((e) => normalizeToLF(e.newText)).join("\n⋯\n"),
			snippetOnly: true,
			rawBefore: raw,
		};
	}
	return { tool: "edit", path: input.path, absPath, isNew: false, oldContent: editBase, newContent, editBase, rawBefore: raw };
}

export function changedSinceProposal(proposal: Proposal): boolean {
	let current: string | null = null;
	try {
		current = existsSync(proposal.absPath) ? readFileSync(proposal.absPath, "utf8") : null;
	} catch {
		return true;
	}
	return current !== proposal.rawBefore;
}

export function rewriteInputForContent(proposal: Proposal, input: any, content: string): void {
	if (proposal.tool === "write") {
		input.content = content;
		return;
	}
	delete input.oldText;
	delete input.newText;
	const base = proposal.editBase ?? proposal.oldContent;
	const target = normalizeToLF(content);
	input.edits = minimalEdits(base, target) ?? [{ oldText: base, newText: target }];
}

interface Region {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}

function lineDiffRegions(a: string[], b: string[]): Region[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const n = endA - start;
	const m = endB - start;
	if (n * m > 4_000_000) return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
	const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i][j] = a[start + i] === b[start + j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const regions: Region[] = [];
	let open: Region | undefined;
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[start + i] === b[start + j]) {
			if (open) regions.push(open);
			open = undefined;
			i++;
			j++;
			continue;
		}
		open ??= { aStart: start + i, aEnd: start + i, bStart: start + j, bEnd: start + j };
		if (j >= m || (i < n && table[i + 1][j] >= table[i][j + 1])) open.aEnd = start + ++i;
		else open.bEnd = start + ++j;
	}
	if (open) regions.push(open);
	return regions;
}

function occursOnce(haystack: string, needle: string): boolean {
	if (!needle) return false;
	const first = haystack.indexOf(needle);
	return first !== -1 && haystack.indexOf(needle, first + 1) === -1;
}

export function minimalEdits(base: string, target: string): TextEdit[] | undefined {
	if (base === target) return undefined;
	const a = base.split("\n");
	const b = target.split("\n");
	const windows = lineDiffRegions(a, b).map((region) => {
		const w = { ...region };
		while (!occursOnce(base, a.slice(w.aStart, w.aEnd).join("\n")) && (w.aStart > 0 || w.aEnd < a.length)) {
			if (w.aStart > 0) {
				w.aStart--;
				w.bStart--;
			}
			if (w.aEnd < a.length) {
				w.aEnd++;
				w.bEnd++;
			}
		}
		return w;
	});
	const merged: Region[] = [];
	for (const w of windows) {
		const last = merged.at(-1);
		if (last && w.aStart <= last.aEnd) {
			last.aEnd = Math.max(last.aEnd, w.aEnd);
			last.bEnd = Math.max(last.bEnd, w.bEnd);
		} else merged.push({ ...w });
	}
	const edits = merged.map((w) => ({ oldText: a.slice(w.aStart, w.aEnd).join("\n"), newText: b.slice(w.bStart, w.bEnd).join("\n") }));
	if (!edits.length || edits.some((e) => !occursOnce(base, e.oldText))) return undefined;
	return applyEdits(base, edits) === target ? edits : undefined;
}

export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
	const a = normalizeToLF(oldText).split("\n");
	const b = normalizeToLF(newText).split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length - 1;
	let endB = b.length - 1;
	while (endA >= start && endB >= start && a[endA] === b[endB]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA + 1);
	const midB = b.slice(start, endB + 1);
	const ops: Array<[" " | "-" | "+", string]> = [];
	if (midA.length * midB.length <= 4_000_000) {
		const n = midA.length;
		const m = midB.length;
		const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				ops.push([" ", midA[i]]);
				i++;
				j++;
			} else if (table[i + 1][j] >= table[i][j + 1]) ops.push(["-", midA[i++]]);
			else ops.push(["+", midB[j++]]);
		}
		while (i < n) ops.push(["-", midA[i++]]);
		while (j < m) ops.push(["+", midB[j++]]);
	} else {
		for (const line of midA) ops.push(["-", line]);
		for (const line of midB) ops.push(["+", line]);
	}
	const before = a.slice(Math.max(0, start - context), start).map((l) => [" ", l] as [" ", string]);
	const after = a.slice(endA + 1, endA + 1 + context).map((l) => [" ", l] as [" ", string]);
	const body = [...before, ...ops, ...after];
	if (!ops.length) return "(no changes)";
	const header = `--- a/${path}\n+++ b/${path}\n@@ -${Math.max(1, start - before.length + 1)} +${Math.max(1, start - before.length + 1)} @@`;
	return `${header}\n${body.map(([sign, line]) => `${sign}${line}`).join("\n")}`;
}

export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of unifiedDiff(oldText, newText, "x", 0).split("\n").slice(3)) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}
