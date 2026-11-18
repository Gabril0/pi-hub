import { extractFacts, isTestPath, languageOf } from "./knowledge-scan.mjs";
import { fileNodeId, mermaidText, ROOT_ID } from "./knowledge-graph.mjs";

const DIAGRAM_TYPES = /^(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram)\b/;
const MAX_MERMAID = 20_000;
const MAX_PER_GROUP = 6;
const NOISE_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock)$|\.min\.[a-z]+$/;

function lineShape(before, after) {
	const remaining = new Map();
	const oldLines = before ? before.split("\n") : [];
	for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
	let added = 0;
	let runs = 0;
	let inRun = false;
	for (const line of after ? after.split("\n") : []) {
		const left = remaining.get(line) ?? 0;
		if (left > 0) {
			remaining.set(line, left - 1);
			inRun = false;
			continue;
		}
		added++;
		if (!inRun) runs++;
		inRun = true;
	}
	const removed = [...remaining.values()].reduce((sum, count) => sum + count, 0);
	return { added, removed, runs };
}

function missing(after, before, keyOf) {
	const known = new Set(before.map(keyOf));
	const seen = new Set();
	return after.filter((item) => {
		const key = keyOf(item);
		if (known.has(key) || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function changeFacts({ path, before = "", after = "" }) {
	const previous = extractFacts(path, before ?? "");
	const next = extractFacts(path, after ?? "");
	return {
		path,
		shape: lineShape(before ?? "", after ?? ""),
		symbols: missing(next.symbols, previous.symbols, (s) => s.name),
		imports: missing(next.imports, previous.imports, (i) => i.spec),
		routes: missing(next.routes, previous.routes, (r) => `${r.method} ${r.path}`),
		calls: missing(next.calls, previous.calls, (c) => `${c.method} ${c.host ?? ""}${c.path ?? ""}`),
		publishes: missing(next.publishes, previous.publishes, (t) => t.name),
		subscribes: missing(next.subscribes, previous.subscribes, (t) => t.name),
		stores: missing(next.stores, previous.stores, (s) => s.name),
	};
}

function relevant(file) {
	return !file.binary && !file.tooLarge && languageOf(file.path) && !NOISE_FILE.test(file.path);
}

export function changeComplexity(files) {
	const facts = files.filter(relevant).map(changeFacts);
	const production = facts.filter((f) => !isTestPath(f.path));
	const changed = facts.reduce((sum, f) => sum + f.shape.added + f.shape.removed, 0);
	const runs = facts.reduce((sum, f) => sum + f.shape.runs, 0);
	const wires = production.reduce((sum, f) => sum + f.routes.length + f.calls.length + f.publishes.length + f.subscribes.length + f.stores.length, 0);
	const symbols = production.reduce((sum, f) => sum + f.symbols.length, 0);
	const reasons = [];
	if (changed >= 60) reasons.push(`${changed} changed lines`);
	if (production.length >= 3 && changed >= 20) reasons.push(`${production.length} source files`);
	if (runs >= 5 && changed >= 20) reasons.push(`${runs} separate changes`);
	if (wires > 0 && changed >= 6) reasons.push(`${wires} new connection${wires === 1 ? "" : "s"} to other systems`);
	if (symbols >= 4 && changed >= 20) reasons.push(`${symbols} new functions or types`);
	return { complex: reasons.length > 0, reasons, facts: production, changed };
}

function short(path) {
	const parts = String(path).split("/");
	return parts.length > 2 ? parts.slice(-2).join("/") : path;
}

function connectedFiles(model, repoKey, path) {
	if (!model || !repoKey) return { callers: [] };
	const id = fileNodeId(repoKey, path);
	if (!model.nodes.has(id)) return { callers: [] };
	const callers = new Map();
	for (const edge of model.edges) {
		const target = edge.to.startsWith("sym:") ? model.nodes.get(edge.to)?.parent : edge.to;
		if (target !== id || edge.from === id) continue;
		const from = model.nodes.get(edge.from);
		if (!from || from.test) continue;
		callers.set(edge.from, { label: from.path ? short(from.path) : from.label, kind: edge.kind });
	}
	return { callers: [...callers.values()].slice(0, 4) };
}

function callTargetLabel(model, repoKey, path, call) {
	const wanted = `${call.method === "ANY" ? "" : `${call.method} `}${call.path ?? call.host}`;
	if (model && repoKey) {
		const edge = model.edges.find((e) => e.kind === "http" && e.from === fileNodeId(repoKey, path) && e.detail === wanted);
		const node = edge && model.nodes.get(edge.to);
		if (node?.parent === ROOT_ID) return node.label;
		if (node?.repo) return `${model.nodes.get(`repo:${node.repo}`).label}: ${short(node.path)}`;
	}
	return call.host ?? "HTTP service";
}

export function changeDiagram(files, { model, repoKey } = {}) {
	const { facts } = changeComplexity(files);
	if (!facts.length) return undefined;
	const lines = ["flowchart LR"];
	const named = new Map();
	let counter = 0;
	const node = (key, label, shape = "box") => {
		if (named.has(key)) return named.get(key);
		const id = `n${counter++}`;
		named.set(key, id);
		const text = `"${mermaidText(label)}"`;
		lines.push(`  ${id}${shape === "store" ? `[(${text})]` : shape === "event" ? `>${text}]` : shape === "round" ? `(${text})` : `[${text}]`}`);
		return id;
	};
	const link = (from, to, label, arrow = "-->") => lines.push(`  ${from} ${arrow}${label ? `|"${mermaidText(label, 40)}"|` : ""} ${to}`);
	const changed = [];
	const added = [];
	let wires = 0;
	for (const fact of facts.slice(0, 8)) {
		const file = node(`file:${fact.path}`, short(fact.path));
		changed.push(file);
		for (const caller of connectedFiles(model, repoKey, fact.path).callers) link(node(`caller:${caller.label}`, caller.label, "round"), file, caller.kind === "http" ? "calls" : "uses");
		for (const route of fact.routes.slice(0, MAX_PER_GROUP)) {
			wires++;
			link(node("clients", "HTTP clients", "round"), file, `${route.method === "ANY" ? "" : `${route.method} `}${route.path}`);
		}
		for (const call of fact.calls.slice(0, MAX_PER_GROUP)) {
			wires++;
			link(file, node(`call:${call.host ?? call.path}`, callTargetLabel(model, repoKey, fact.path, call)), `${call.method === "ANY" ? "" : `${call.method} `}${call.path ?? ""}`.trim() || "calls");
		}
		for (const topic of fact.publishes.slice(0, MAX_PER_GROUP)) {
			wires++;
			link(file, node(`topic:${topic.name}`, topic.name, "event"), "publishes", "==>");
		}
		for (const topic of fact.subscribes.slice(0, MAX_PER_GROUP)) {
			wires++;
			link(node(`topic:${topic.name}`, topic.name, "event"), file, "consumed by", "==>");
		}
		for (const store of fact.stores.slice(0, MAX_PER_GROUP)) {
			wires++;
			link(file, node(`store:${store.name}`, store.name, "store"), "reads and writes");
		}
		for (const item of fact.imports.slice(0, 4)) link(file, node(`import:${item.spec}`, item.spec.split("/").pop().split("::").pop() || item.spec), "imports", "-.->");
		for (const symbol of fact.symbols.slice(0, MAX_PER_GROUP)) {
			const id = node(`symbol:${fact.path}:${symbol.name}`, `${symbol.name}${symbol.kind === "function" ? "()" : ""}`, "round");
			added.push(id);
			link(file, id, "adds");
		}
	}
	if (lines.length === 1 + changed.length && changed.length < 2) return undefined;
	lines.push("  classDef changed fill:#1f3a68,stroke:#6ea6ff,color:#e9ecf1", "  classDef added fill:#17351f,stroke:#3fb950,color:#e9ecf1");
	lines.push(`  class ${changed.join(",")} changed`);
	if (added.length) lines.push(`  class ${added.join(",")} added`);
	const fileCount = `${facts.length} file${facts.length === 1 ? "" : "s"}`;
	return {
		title: facts.length === 1 ? `What changes around ${short(facts[0].path)}` : `What changes across ${fileCount}`,
		summary: wires ? `Built from the code: this change adds ${wires} connection${wires === 1 ? "" : "s"} to other parts of the system.` : `Built from the code: the new pieces in ${fileCount} and what already depends on them.`,
		mermaid: lines.join("\n"),
	};
}

export function cleanMermaid(text) {
	const source = String(text ?? "").replace(/\r/g, "").trim();
	if (!source || source.length > MAX_MERMAID) return undefined;
	const lines = source.split("\n").filter((line) => !/^\s*%%/.test(line) && !/^\s*(click|href)\s/i.test(line));
	const body = lines.join("\n").trim();
	return DIAGRAM_TYPES.test(body) ? body : undefined;
}
