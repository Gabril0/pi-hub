const LANGUAGES = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	rs: "rust",
	go: "go",
	py: "python",
	rb: "ruby",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	ps1: "powershell",
	sql: "sql",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	ini: "ini",
	md: "markdown",
	html: "xml",
	xml: "xml",
	svg: "xml",
	css: "css",
	scss: "scss",
	less: "less",
	lua: "lua",
	graphql: "graphql",
	makefile: "makefile",
	dockerfile: "bash",
};

export function languageFor(path) {
	const name = path.split("/").pop().toLowerCase();
	if (name === "makefile") return "makefile";
	if (name === "dockerfile") return "dockerfile";
	const ext = name.includes(".") ? name.split(".").pop() : "";
	const lang = LANGUAGES[ext];
	return lang && window.hljs?.getLanguage(lang) ? lang : undefined;
}

export function splitLines(text) {
	return String(text ?? "").split("\n");
}

function visible(line) {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function diffOps(oldText, newText, { ignoreWhitespace = false } = {}) {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const normalize = ignoreWhitespace ? (s) => s.replace(/\s+/g, " ").trim() : (s) => visible(s);
	const parts = window.Diff.diffArrays(a, b, { comparator: (x, y) => normalize(x) === normalize(y) });
	const ops = [];
	let oldNo = 1;
	let newNo = 1;
	let block = -1;
	let inChange = false;
	for (const part of parts) {
		for (const line of part.value) {
			if (part.added || part.removed) {
				if (!inChange) {
					block++;
					inChange = true;
				}
				if (part.removed) ops.push({ type: "del", oldNo: oldNo++, text: line, block });
				else ops.push({ type: "add", newNo: newNo++, text: line, block });
			} else {
				inChange = false;
				ops.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line, newText: b[newNo - 2] });
			}
		}
	}
	trimPhantomLastLine(ops, a, b);
	return { ops, blocks: block + 1 };
}

function trimPhantomLastLine(ops, a, b) {
	const last = ops.at(-1);
	if (last?.type === "ctx" && last.text === "" && a.at(-1) === "" && b.at(-1) === "") last.phantom = true;
}

export function contentWithBlocks(ops, rejected) {
	const lines = [];
	for (const op of ops) {
		if (op.type === "ctx") lines.push(op.newText ?? op.text);
		else if (op.type === "del" && rejected.has(op.block)) lines.push(op.text);
		else if (op.type === "add" && !rejected.has(op.block)) lines.push(op.text);
	}
	return lines.join("\n");
}

export function stats(ops) {
	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.type === "add" && !(op.text === "" && op === ops.at(-1))) added++;
		else if (op.type === "del") removed++;
	}
	return { added, removed };
}

export function buildHunks(ops, context, expanded) {
	const changed = ops.map((op) => op.type !== "ctx");
	const keep = new Array(ops.length).fill(false);
	for (let i = 0; i < ops.length; i++) {
		if (!changed[i]) continue;
		for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
	}
	const items = [];
	let i = 0;
	let gapIndex = 0;
	while (i < ops.length) {
		if (keep[i] || ops[i].phantom) {
			if (!ops[i].phantom) items.push({ kind: "op", op: ops[i], index: i });
			i++;
			continue;
		}
		const start = i;
		while (i < ops.length && !keep[i]) i++;
		const gap = { kind: "gap", start, end: i, id: gapIndex++ };
		const realEnd = ops[i - 1]?.phantom ? i - 1 : i;
		if (realEnd <= start) continue;
		gap.end = realEnd;
		const state = expanded.get(gap.id);
		if (state === "all") {
			for (let k = start; k < realEnd; k++) items.push({ kind: "op", op: ops[k], index: k });
		} else {
			const top = state?.top ?? 0;
			const bottom = state?.bottom ?? 0;
			for (let k = start; k < Math.min(start + top, realEnd); k++) items.push({ kind: "op", op: ops[k], index: k });
			if (realEnd - start > top + bottom) items.push({ ...gap, hidden: realEnd - start - top - bottom, top, bottom });
			for (let k = Math.max(start + top, realEnd - bottom); k < realEnd; k++) items.push({ kind: "op", op: ops[k], index: k });
		}
	}
	return items;
}

export function pairRows(items) {
	const rows = [];
	let i = 0;
	while (i < items.length) {
		const item = items[i];
		if (item.kind !== "op" || item.op.type === "ctx") {
			rows.push(item.kind === "gap" ? item : { kind: "pair", left: item.op, right: item.op, index: item.index });
			i++;
			continue;
		}
		const dels = [];
		const adds = [];
		while (i < items.length && items[i].kind === "op" && items[i].op.type === "del") dels.push(items[i++].op);
		while (i < items.length && items[i].kind === "op" && items[i].op.type === "add") adds.push(items[i++].op);
		for (const [left, right] of alignBlock(dels, adds)) rows.push({ kind: "pair", left, right, block: (left ?? right).block });
	}
	return rows;
}

export function similarity(a, b) {
	const x = visible(a).trim();
	const y = visible(b).trim();
	if (!x && !y) return 1;
	if (!x || !y) return 0;
	const parts = window.Diff.diffChars(x, y);
	const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
	return (2 * same) / (x.length + y.length);
}

export function alignBlock(dels, adds) {
	if (dels.length * adds.length > 2500) {
		const n = Math.max(dels.length, adds.length);
		return Array.from({ length: n }, (_, k) => [dels[k], adds[k]]);
	}
	const pairs = [];
	let j = 0;
	for (let i = 0; i < dels.length; i++) {
		let best = -1;
		let bestScore = 0.5;
		for (let k = j; k < adds.length; k++) {
			const score = similarity(dels[i].text, adds[k].text);
			if (score > bestScore) {
				best = k;
				bestScore = score;
			}
		}
		if (best === -1) {
			pairs.push([dels[i], undefined]);
			continue;
		}
		while (j < best) pairs.push([undefined, adds[j++]]);
		pairs.push([dels[i], adds[j++]]);
	}
	while (j < adds.length) pairs.push([undefined, adds[j++]]);
	const merged = [];
	for (const pair of pairs) {
		const last = merged.at(-1);
		if (last && pair[0] === undefined && last[1] === undefined && last[0]) last[1] = pair[1];
		else merged.push(pair);
	}
	return merged;
}

export function wordDiff(oldLine, newLine) {
	const parts = window.Diff.diffWordsWithSpace(visible(oldLine), visible(newLine));
	const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
	const longest = Math.max(visible(oldLine).length, visible(newLine).length, 1);
	if (same / longest < 0.35) return undefined;
	return {
		left: parts.filter((p) => !p.added).map((p) => ({ text: p.value, mark: p.removed })),
		right: parts.filter((p) => !p.removed).map((p) => ({ text: p.value, mark: p.added })),
		changed: parts.filter((p) => p.added || p.removed).map((p) => p.value.trim()).filter(Boolean),
	};
}

const HASHLIKE = /^(?:[0-9a-f]{7,64}|v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?|\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)$/i;

export function smartCollapse(ops) {
	const byBlock = new Map();
	for (const op of ops) {
		if (op.type === "ctx") continue;
		const entry = byBlock.get(op.block) ?? { dels: [], adds: [] };
		(op.type === "del" ? entry.dels : entry.adds).push(op);
		byBlock.set(op.block, entry);
	}
	const summaries = new Map();
	for (const [block, { dels, adds }] of byBlock) {
		if (dels.length !== adds.length || dels.length < 2) continue;
		const from = new Set();
		const to = new Set();
		let ok = true;
		for (let i = 0; i < dels.length && ok; i++) {
			const parts = window.Diff.diffWordsWithSpace(visible(dels[i].text), visible(adds[i].text));
			for (const part of parts) {
				if (!part.added && !part.removed) continue;
				const tokens = part.value.split(/[^\w.+-]+/).filter(Boolean);
				if (!tokens.length || !tokens.every((t) => HASHLIKE.test(t))) {
					ok = false;
					break;
				}
				for (const t of tokens) (part.removed ? from : to).add(t);
			}
		}
		if (ok && (from.size || to.size)) summaries.set(block, { lines: dels.length, from: [...from], to: [...to], keys: changedKeys(dels) });
	}
	return summaries;
}

const KEY_PATTERN = /^\s*(?:[-*]\s+)?["'`]?([^"'`=:\s][^"'`=:]*?)["'`]?\s*[:=]/;

function changedKeys(dels) {
	const keys = new Set();
	for (const op of dels) {
		const match = visible(op.text).match(KEY_PATTERN);
		if (match) keys.add(match[1].trim());
	}
	return [...keys];
}

export function highlightLines(text, language) {
	const lines = splitLines(text).map(visible);
	if (!language || !window.hljs || text.length > 400_000) return lines.map(escape);
	let markup;
	try {
		markup = window.hljs.highlight(lines.join("\n"), { language, ignoreIllegals: true }).value;
	} catch {
		return lines.map(escape);
	}
	const out = [];
	let open = [];
	for (const raw of markup.split("\n")) {
		let line = open.join("") + raw;
		const tags = raw.match(/<span[^>]*>|<\/span>/g) ?? [];
		for (const tag of tags) {
			if (tag === "</span>") open.pop();
			else open.push(tag);
		}
		line += "</span>".repeat(open.length);
		out.push(line);
	}
	return out;
}

export function escape(text) {
	return String(text ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
