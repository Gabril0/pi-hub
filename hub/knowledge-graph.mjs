import { posix } from "node:path";
import { STORE_PACKAGES } from "./knowledge-scan.mjs";

export const ROOT_ID = "root";
const MAX_VIEW_NODES = 36;
const MAX_GHOSTS = 14;
const MAX_DETAILS = 8;
const MAX_EVIDENCE = 6;
const GENERIC_ROUTES = new Set(["/", "/health", "/healthz", "/ready", "/readyz", "/live", "/livez", "/metrics", "/status", "/ping", "/version", "/login", "/logout"]);
const KIND_WORDS = { import: "imports", http: "calls over HTTP", event: "sends events to", package: "depends on", store: "uses", link: "relates to", contains: "contains" };

export const repoNodeId = (key) => `repo:${key}`;
export const dirNodeId = (key, path) => `dir:${key}:${path}`;
export const fileNodeId = (key, path) => `file:${key}:${path}`;
export const symbolNodeId = (key, path, name) => `sym:${key}:${path}#${name}`;
export const externalNodeId = (name) => `ext:${name}`;

export function squash(value) {
	return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function addNode(model, node) {
	if (model.nodes.has(node.id)) return model.nodes.get(node.id);
	model.nodes.set(node.id, node);
	const siblings = model.children.get(node.parent) ?? [];
	siblings.push(node.id);
	model.children.set(node.parent, siblings);
	return node;
}

function ensureDir(model, key, path) {
	if (path === "." || path === "") return repoNodeId(key);
	const id = dirNodeId(key, path);
	if (!model.nodes.has(id)) {
		const parent = ensureDir(model, key, posix.dirname(path));
		addNode(model, { id, kind: "domain", label: posix.basename(path), parent, repo: key, path, files: 0, lines: 0, languages: {} });
	}
	return id;
}

function ensureExternal(model, name, type) {
	const id = externalNodeId(name);
	addNode(model, { id, kind: type, label: name, parent: ROOT_ID, files: 0, lines: 0, languages: {} });
	return id;
}

function addEdge(model, edge) {
	if (edge.from !== edge.to && model.nodes.has(edge.from) && model.nodes.has(edge.to)) model.edges.push(edge);
}

function routeMatches(callPath, route) {
	if (callPath === route) return "confirmed";
	if (route.split("/").length >= 2 && !GENERIC_ROUTES.has(route) && callPath.endsWith(route)) return "likely";
	return undefined;
}

function methodsAgree(a, b) {
	return a === "ANY" || b === "ANY" || a === b;
}

function repoMatchesName(repo, text) {
	const needle = squash(text);
	return needle.length >= 4 && (repo.squashed === needle || repo.aliases.has(needle));
}

function repoMatchesHost(repo, host) {
	const labels = host.split(".");
	const joined = squash(labels.slice(0, -1).join(""));
	return labels.some((label) => repoMatchesName(repo, label)) || repoMatchesName(repo, joined);
}

function evidence(file, line, detail) {
	return { file, line, detail };
}

export function buildModel({ repos = [], notes = [], links = [] } = {}) {
	const model = { nodes: new Map(), children: new Map(), edges: [], notes: new Map(), repos: new Map() };
	addNode(model, { id: ROOT_ID, kind: "workspace", label: "Workspace", parent: null, files: 0, lines: 0, languages: {} });
	const contexts = [];

	for (const repo of repos) {
		const context = { ...repo, squashed: squash(repo.name), aliases: new Set((repo.manifest?.names ?? []).map(squash)) };
		for (const name of repo.manifest?.names ?? []) context.aliases.add(squash(name.split("/").pop()));
		context.aliases.add(squash(repo.name.replace(/[-_](api|service|svc|server|web|worker|app)$/i, "")));
		contexts.push(context);
		model.repos.set(repo.key, context);
		addNode(model, { id: repoNodeId(repo.key), kind: "repo", label: repo.name, parent: ROOT_ID, repo: repo.key, root: repo.root, path: "", description: repo.description, files: 0, lines: 0, languages: {} });
		for (const file of repo.files ?? []) {
			const parent = ensureDir(model, repo.key, posix.dirname(file.path));
			const id = fileNodeId(repo.key, file.path);
			addNode(model, { id, kind: "file", label: posix.basename(file.path), parent, repo: repo.key, path: file.path, language: file.language, test: file.test, files: 1, lines: file.lines, languages: { [file.language]: 1 } });
			for (const symbol of file.symbols ?? []) {
				if (symbol.exported) addNode(model, { id: symbolNodeId(repo.key, file.path, symbol.name), kind: "symbol", label: symbol.name, parent: id, repo: repo.key, path: file.path, line: symbol.line, symbolKind: symbol.kind, files: 0, lines: 0, languages: {} });
			}
			for (let at = parent; at && at !== ROOT_ID; at = model.nodes.get(at).parent) {
				const node = model.nodes.get(at);
				node.files++;
				node.lines += file.lines;
				node.languages[file.language] = (node.languages[file.language] ?? 0) + 1;
			}
		}
	}

	const packageOwners = new Map();
	for (const repo of contexts) for (const name of repo.manifest?.names ?? []) packageOwners.set(squash(name), repo);
	const served = [];
	const subscribers = new Map();
	for (const repo of contexts) {
		for (const file of repo.files ?? []) {
			for (const route of file.routes ?? []) served.push({ ...route, repo, file: file.path });
			for (const topic of file.subscribes ?? []) {
				const list = subscribers.get(topic.name) ?? [];
				list.push({ repo, file: file.path, line: topic.line });
				subscribers.set(topic.name, list);
			}
		}
	}

	for (const repo of contexts) {
		const repoId = repoNodeId(repo.key);
		for (const dep of repo.manifest?.deps ?? []) {
			const owner = packageOwners.get(squash(dep));
			if (owner && owner.key !== repo.key) addEdge(model, { from: repoId, to: repoNodeId(owner.key), kind: "package", detail: dep, confidence: "confirmed", evidence: evidence("manifest", 0, dep) });
		}
		for (const file of repo.files ?? []) {
			const from = fileNodeId(repo.key, file.path);
			for (const item of file.imports ?? []) {
				if (item.file) {
					const symbols = (item.names ?? []).map((name) => symbolNodeId(repo.key, item.file, name)).filter((id) => model.nodes.has(id));
					for (const to of symbols.length ? symbols : [fileNodeId(repo.key, item.file)]) {
						addEdge(model, { from, to, kind: "import", detail: to.startsWith("sym:") ? to.split("#").pop() : undefined, confidence: "confirmed", evidence: evidence(file.path, item.line, item.file) });
					}
				} else if (item.dir) {
					addEdge(model, { from, to: dirNodeId(repo.key, item.dir), kind: "import", confidence: "confirmed", evidence: evidence(file.path, item.line, item.dir) });
				} else if (item.pkg) {
					const owner = packageOwners.get(squash(item.pkg));
					if (owner && owner.key !== repo.key) {
						const symbols = (item.names ?? []).flatMap((name) => (owner.files ?? []).filter((f) => f.symbols?.some((s) => s.exported && s.name === name)).slice(0, 1).map((f) => symbolNodeId(owner.key, f.path, name)));
						for (const to of symbols.length ? symbols : [repoNodeId(owner.key)]) addEdge(model, { from, to, kind: "package", detail: item.pkg, confidence: "confirmed", evidence: evidence(file.path, item.line, item.pkg) });
					} else if (STORE_PACKAGES[item.pkg]) {
						addEdge(model, { from, to: ensureExternal(model, STORE_PACKAGES[item.pkg], "store"), kind: "store", detail: item.pkg, confidence: "confirmed", evidence: evidence(file.path, item.line, item.pkg) });
					}
				}
			}
			for (const call of file.calls ?? []) linkCall(model, contexts, served, repo, file, from, call);
			for (const env of file.envs ?? []) {
				const name = env.name.replace(/_(?:BASE_)?(?:URL|URI|HOST|ENDPOINT|ADDR|ADDRESS)$/, "");
				const target = contexts.find((other) => other.key !== repo.key && repoMatchesName(other, name));
				if (target) addEdge(model, { from, to: repoNodeId(target.key), kind: "http", detail: env.name, confidence: "likely", evidence: evidence(file.path, env.line, env.name) });
			}
			for (const store of file.stores ?? []) addEdge(model, { from, to: ensureExternal(model, store.name, "store"), kind: "store", detail: store.name, confidence: "confirmed", evidence: evidence(file.path, store.line, store.name) });
			for (const topic of file.publishes ?? []) {
				for (const target of subscribers.get(topic.name) ?? []) {
					addEdge(model, { from, to: fileNodeId(target.repo.key, target.file), kind: "event", detail: topic.name, confidence: "confirmed", evidence: evidence(file.path, topic.line, topic.name) });
				}
			}
		}
	}

	for (const link of links) {
		if (model.nodes.has(link.from) && model.nodes.has(link.to)) addEdge(model, { from: link.from, to: link.to, kind: "link", detail: link.label, confidence: "stated", linkId: link.id, by: link.byName, evidence: evidence(link.byName ?? "note", 0, link.label) });
	}
	for (const note of notes) {
		const list = model.notes.get(note.target) ?? [];
		list.push(note);
		model.notes.set(note.target, list);
	}
	return model;
}

function linkCall(model, contexts, served, repo, file, from, call) {
	const label = `${call.method === "ANY" ? "" : `${call.method} `}${call.path ?? call.host}`;
	const add = (to, confidence) => addEdge(model, { from, to, kind: "http", detail: label, confidence, evidence: evidence(file.path, call.line, label) });
	const hostRepo = call.host ? contexts.find((other) => other.key !== repo.key && repoMatchesHost(other, call.host)) : undefined;
	const baseRepo = call.base ? contexts.find((other) => other.key !== repo.key && repoMatchesName(other, String(call.base).split(".").pop().replace(/_?(?:BASE_?)?(?:URL|URI|HOST|ENDPOINT|ADDR)$/i, ""))) : undefined;
	const named = hostRepo ?? baseRepo;
	let candidates = [];
	if (call.path) {
		candidates = served
			.filter((route) => methodsAgree(call.method, route.method))
			.map((route) => ({ route, match: routeMatches(call.path, route.path) }))
			.filter(({ route, match }) => match && (route.repo.key === repo.key || !GENERIC_ROUTES.has(route.path)));
		if (named) candidates = candidates.filter(({ route }) => route.repo.key === named.key);
		else if (!call.host && candidates.some(({ route }) => route.repo.key === repo.key)) candidates = candidates.filter(({ route }) => route.repo.key === repo.key);
		else if (call.host) candidates = [];
	}
	if (candidates.length) {
		const owners = new Set(candidates.map(({ route }) => route.repo.key));
		const seen = new Set();
		for (const { route, match } of candidates) {
			const to = fileNodeId(route.repo.key, route.file);
			if (seen.has(to)) continue;
			seen.add(to);
			add(to, owners.size > 1 ? "possible" : match);
		}
		return;
	}
	if (named) add(repoNodeId(named.key), "likely");
	else if (call.host) add(ensureExternal(model, call.host, "external"), "confirmed");
}

function chainOf(model, id) {
	const chain = [];
	for (let at = id; at; at = model.nodes.get(at)?.parent) chain.unshift(at);
	return chain;
}

function isPassThrough(model, id) {
	const node = model.nodes.get(id);
	if (node?.kind !== "domain") return false;
	const kids = model.children.get(id) ?? [];
	const siblings = model.children.get(node.parent) ?? [];
	return (kids.length === 1 && model.nodes.get(kids[0])?.kind === "domain") || (siblings.length === 1 && ["domain", "repo"].includes(model.nodes.get(node.parent)?.kind));
}

function visibleChildren(model, id) {
	const kids = model.children.get(id) ?? [];
	if (kids.length === 1 && model.nodes.get(kids[0]).kind === "domain") return visibleChildren(model, kids[0]);
	return kids.map((kid) => {
		let at = kid;
		for (;;) {
			const inner = model.children.get(at) ?? [];
			if (model.nodes.get(at).kind === "domain" && inner.length === 1 && model.nodes.get(inner[0]).kind === "domain") at = inner[0];
			else return at;
		}
	});
}

function collapsedBase(model, focusId) {
	let at = focusId;
	for (;;) {
		const kids = model.children.get(at) ?? [];
		if (kids.length === 1 && model.nodes.get(kids[0]).kind === "domain") at = kids[0];
		else return model.nodes.get(at)?.path ?? "";
	}
}

function relativeLabel(model, id, focusId) {
	const node = model.nodes.get(id);
	if (node.kind !== "domain") return node.label;
	const base = collapsedBase(model, focusId);
	return base && node.path.startsWith(`${base}/`) ? node.path.slice(base.length + 1) : node.path;
}

function liftEndpoint(model, id, focusId, visible, focusChain) {
	const chain = chainOf(model, id);
	for (let i = chain.length - 1; i >= 0; i--) if (visible.has(chain[i])) return { id: chain[i], ghost: false };
	let shared = 0;
	while (shared < chain.length && shared < focusChain.length && chain[shared] === focusChain[shared]) shared++;
	if (shared === focusChain.length) return undefined;
	let index = shared;
	while (index < chain.length - 1 && isPassThrough(model, chain[index])) index++;
	const target = chain[index] ?? chain.at(-1);
	return { id: target, ghost: true };
}

function topLanguage(languages) {
	return Object.entries(languages ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function notesUnder(model, id) {
	let count = 0;
	for (const [target, list] of model.notes) if (target === id || chainOf(model, target).includes(id)) count += list.length;
	return count;
}

function agentsOn(model, id, activity) {
	const node = model.nodes.get(id);
	const found = new Set();
	for (const entry of activity ?? []) {
		if (id === ROOT_ID) continue;
		if (node.kind === "repo" && entry.repo === node.repo) found.add(entry.sessionId);
		else if (entry.repo === node.repo && entry.path && (entry.path === node.path || entry.path.startsWith(`${node.path}/`))) found.add(entry.sessionId);
	}
	return [...found];
}

function subtitle(node) {
	if (node.kind === "symbol") return `${node.symbolKind} · line ${node.line}`;
	if (node.kind === "store") return "datastore";
	if (node.kind === "external") return "external service";
	if (node.kind === "file") return `${node.lines} lines · ${node.language}`;
	if (node.kind === "more") return "not shown";
	return `${node.files} file${node.files === 1 ? "" : "s"}${topLanguage(node.languages) ? ` · ${topLanguage(node.languages)}` : ""}`;
}

function publicNode(model, id, focusId, { ghost = false, activity } = {}) {
	const node = model.nodes.get(id);
	return {
		id,
		kind: node.kind,
		label: id === focusId || ghost ? ghostLabel(model, id, focusId) : relativeLabel(model, id, focusId),
		sub: subtitle(node),
		path: node.path,
		line: node.line,
		repo: node.repo,
		description: node.description,
		ghost,
		self: id === focusId,
		drillable: ["repo", "domain", "file"].includes(node.kind) && id !== focusId,
		files: node.files,
		lines: node.lines,
		language: node.language ?? topLanguage(node.languages),
		notes: notesUnder(model, id),
		agents: agentsOn(model, id, activity),
	};
}

function ghostLabel(model, id, focusId) {
	const node = model.nodes.get(id);
	const focus = model.nodes.get(focusId);
	if (node.kind === "symbol") return `${model.nodes.get(node.parent).label} · ${node.label}`;
	if (node.repo && node.repo !== focus?.repo && node.kind !== "repo") return `${model.nodes.get(repoNodeId(node.repo)).label}/${node.path}`;
	return node.kind === "domain" ? node.path : node.label;
}

export function viewGraph(model, focusId = ROOT_ID, { activity } = {}) {
	const focusNode = model.nodes.get(focusId);
	if (!focusNode) return undefined;
	const focusChain = chainOf(model, focusId);
	const children = visibleChildren(model, focusId);
	const degree = new Map();
	const visible = new Set(children);
	const collect = () => {
		const merged = new Map();
		const ghosts = new Map();
		for (const edge of model.edges) {
			const fromChain = chainOf(model, edge.from);
			const toChain = chainOf(model, edge.to);
			if (focusId !== ROOT_ID && !fromChain.includes(focusId) && !toChain.includes(focusId)) continue;
			const inFrom = fromChain.includes(focusId);
			const inTo = toChain.includes(focusId);
			const from = inFrom ? resolveInside(model, edge.from, focusId, visible, fromChain) : liftEndpoint(model, edge.from, focusId, visible, focusChain);
			const to = inTo ? resolveInside(model, edge.to, focusId, visible, toChain) : liftEndpoint(model, edge.to, focusId, visible, focusChain);
			if (!from || !to || from.id === to.id) continue;
			if (from.ghost) ghosts.set(from.id, (ghosts.get(from.id) ?? 0) + 1);
			if (to.ghost) ghosts.set(to.id, (ghosts.get(to.id) ?? 0) + 1);
			const key = `${from.id}|${to.id}|${edge.kind}`;
			const item = merged.get(key) ?? { id: key, from: from.id, to: to.id, kind: edge.kind, count: 0, details: [], evidence: [], confidence: edge.confidence, linkIds: [], by: edge.by };
			item.count++;
			if (edge.detail && !item.details.includes(edge.detail) && item.details.length < MAX_DETAILS) item.details.push(edge.detail);
			if (edge.evidence && item.evidence.length < MAX_EVIDENCE) item.evidence.push({ ...edge.evidence, repo: model.nodes.get(edge.from)?.repo });
			if (edge.linkId) item.linkIds.push(edge.linkId);
			if (rank(edge.confidence) > rank(item.confidence)) item.confidence = edge.confidence;
			merged.set(key, item);
		}
		return { merged, ghosts };
	};
	let { merged, ghosts } = collect();
	for (const edge of merged.values()) {
		degree.set(edge.from, (degree.get(edge.from) ?? 0) + edge.count);
		degree.set(edge.to, (degree.get(edge.to) ?? 0) + edge.count);
	}
	let hidden = [];
	if (children.length > MAX_VIEW_NODES) {
		const ranked = [...children].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (model.nodes.get(b).lines ?? 0) - (model.nodes.get(a).lines ?? 0));
		const kept = new Set(ranked.slice(0, MAX_VIEW_NODES));
		hidden = children.filter((id) => !kept.has(id));
		for (const edge of [...merged.values()]) if (hidden.includes(edge.from) || hidden.includes(edge.to)) merged.delete(edge.id);
		for (const id of hidden) visible.delete(id);
	}
	const keptGhosts = new Set([...ghosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_GHOSTS).map(([id]) => id));
	const edges = [...merged.values()].filter((edge) => (visible.has(edge.from) || keptGhosts.has(edge.from) || edge.from === focusId) && (visible.has(edge.to) || keptGhosts.has(edge.to) || edge.to === focusId));
	const used = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
	const nodes = [...visible].map((id) => publicNode(model, id, focusId, { activity }));
	if (used.has(focusId) && focusId !== ROOT_ID) nodes.unshift(publicNode(model, focusId, focusId, { activity }));
	for (const id of keptGhosts) if (used.has(id) && !visible.has(id) && id !== focusId) nodes.push(publicNode(model, id, focusId, { ghost: true, activity }));
	const labels = new Map(nodes.map((node) => [node.id, node.label]));
	const decorated = edges.map((edge) => ({ ...edge, sentence: edgeSentence(edge, labels) }));
	return {
		focus: publicNode(model, focusId, focusId, { activity }),
		level: focusNode.kind,
		crumbs: focusChain.filter((id) => id === focusId || !isPassThrough(model, id)).map((id) => ({ id, label: id === ROOT_ID ? "Workspace" : model.nodes.get(id).kind === "domain" ? model.nodes.get(id).path : model.nodes.get(id).label, kind: model.nodes.get(id).kind })),
		nodes,
		edges: decorated,
		hidden: hidden.length,
		notes: (model.notes.get(focusId) ?? []).slice().sort((a, b) => b.createdAt - a.createdAt),
		mermaid: viewMermaid(nodes, decorated),
	};
}

function resolveInside(model, id, focusId, visible, chain) {
	if (id === focusId) return { id: focusId, ghost: false };
	for (let i = chain.length - 1; i >= 0; i--) {
		if (visible.has(chain[i])) return { id: chain[i], ghost: false };
		if (chain[i] === focusId) return { id: focusId, ghost: false };
	}
	return undefined;
}

function rank(confidence) {
	return { possible: 0, likely: 1, confirmed: 2, stated: 3 }[confidence] ?? 0;
}

export function edgeSentence(edge, labels) {
	const from = labels.get(edge.from) ?? edge.from;
	const to = labels.get(edge.to) ?? edge.to;
	const details = edge.details?.length ? edge.details.slice(0, 3).join(", ") : "";
	const hedge = edge.confidence === "possible" ? " (possibly)" : edge.confidence === "likely" ? " (likely)" : "";
	if (edge.kind === "http") return `${from} calls ${to} over HTTP${details ? `: ${details}` : ""}${hedge}`;
	if (edge.kind === "event") return `${from} publishes ${details || "events"} consumed by ${to}`;
	if (edge.kind === "import") return details && details !== to ? `${from} imports ${details} from ${to}` : `${from} imports ${to}`;
	if (edge.kind === "package") return `${from} depends on ${to}${details ? ` through the ${details} package` : ""}`;
	if (edge.kind === "store") return `${from} uses ${to}`;
	return `${from} → ${to}${details ? `: ${details}` : ""}${edge.by ? ` (noted by ${edge.by})` : ""}`;
}

export function mermaidText(value, max = 60) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	const short = text.length > max ? `${text.slice(0, max - 1)}…` : text;
	return short.replace(/&/g, "#amp;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\|/g, "#124;");
}

function viewMermaid(nodes, edges) {
	const ids = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
	const lines = ["flowchart LR"];
	for (const node of nodes) {
		const label = `"${mermaidText(node.label)}"`;
		const shape = node.kind === "store" ? `[(${label})]` : node.kind === "external" ? `((${label}))` : `[${label}]`;
		lines.push(`  ${ids.get(node.id)}${shape}`);
	}
	for (const edge of edges) {
		const detail = edge.details?.[0] ?? KIND_WORDS[edge.kind] ?? edge.kind;
		const arrow = edge.kind === "import" ? "-.->" : edge.kind === "event" ? "==>" : "-->";
		lines.push(`  ${ids.get(edge.from)} ${arrow}|"${mermaidText(detail, 40)}"| ${ids.get(edge.to)}`);
	}
	return lines.join("\n");
}

export function searchNodes(model, query, limit = 20) {
	const needle = String(query ?? "").trim().toLowerCase();
	if (!needle) return [];
	const scored = [];
	for (const node of model.nodes.values()) {
		if (node.id === ROOT_ID) continue;
		const label = node.label.toLowerCase();
		const path = String(node.path ?? "").toLowerCase();
		const score = label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : path.includes(needle) ? 3 : -1;
		if (score >= 0) scored.push({ score, node });
	}
	return scored
		.sort((a, b) => a.score - b.score || a.node.label.length - b.node.label.length)
		.slice(0, limit)
		.map(({ node }) => ({ id: node.kind === "symbol" ? node.parent : node.id, label: node.label, kind: node.kind, repo: node.repo ? model.nodes.get(repoNodeId(node.repo))?.label : undefined, path: node.path }));
}

export function resolveTarget(model, text, { repoKey } = {}) {
	const value = String(text ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
	if (!value || value === "workspace" || value === ROOT_ID) return ROOT_ID;
	if (model.nodes.has(value)) return value;
	const inRepo = (key, path) => {
		if (!path || path === ".") return repoNodeId(key);
		const [file, symbol] = path.split("#");
		if (symbol && model.nodes.has(symbolNodeId(key, file, symbol))) return symbolNodeId(key, file, symbol);
		if (model.nodes.has(fileNodeId(key, file))) return fileNodeId(key, file);
		if (model.nodes.has(dirNodeId(key, file))) return dirNodeId(key, file);
		return undefined;
	};
	if (repoKey) {
		const found = value === "." ? repoNodeId(repoKey) : inRepo(repoKey, value);
		if (found) return found;
	}
	for (const repo of model.repos.values()) {
		if (value.toLowerCase() === repo.name.toLowerCase()) return repoNodeId(repo.key);
		if (value.toLowerCase().startsWith(`${repo.name.toLowerCase()}/`)) {
			const found = inRepo(repo.key, value.slice(repo.name.length + 1));
			if (found) return found;
		}
	}
	const external = externalNodeId(value.toLowerCase());
	return model.nodes.has(external) ? external : undefined;
}

export function describeNode(model, id) {
	const view = viewGraph(model, id);
	if (!view) return "";
	const node = model.nodes.get(id);
	const lines = [`${node.kind === "workspace" ? "Workspace" : `${node.kind} ${node.repo && node.kind !== "repo" ? `${model.nodes.get(repoNodeId(node.repo)).label}/${node.path}` : node.label}`}${node.files ? ` (${node.files} files, ${node.lines} lines)` : ""}`];
	if (node.description) lines.push(node.description);
	const parts = view.nodes.filter((n) => !n.ghost && !n.self).slice(0, 16).map((n) => n.label);
	if (parts.length) lines.push(`Contains: ${parts.join(", ")}`);
	const relations = view.edges.filter((edge) => edge.kind !== "import" || id !== ROOT_ID).slice(0, 14).map((edge) => `- ${edge.sentence}`);
	if (relations.length) lines.push("Connections:", ...relations);
	const notes = [...model.notes.entries()].filter(([target]) => target === id || chainOf(model, target).includes(id)).flatMap(([target, list]) => list.map((note) => ({ ...note, target })));
	if (notes.length) {
		lines.push("Notes:");
		for (const note of notes.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)) lines.push(`- [${model.nodes.get(note.target)?.label ?? note.target}] ${note.text} (${note.byName ?? "unknown"})`);
	}
	return lines.join("\n");
}

function table(rows) {
	return rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
}

export function repoMarkdown(model, key) {
	const id = repoNodeId(key);
	const node = model.nodes.get(id);
	const view = viewGraph(model, id);
	const whole = viewGraph(model, ROOT_ID);
	const repo = model.repos.get(key);
	const out = [`# ${node.label}`, "", node.description || "_No description yet._", "", `- Root: \`${node.root}\``, `- ${node.files} source files, ${node.lines} lines`, `- Languages: ${Object.entries(node.languages).map(([k, v]) => `${k} (${v})`).join(", ") || "none detected"}`, ""];
	const domains = view.nodes.filter((n) => !n.ghost && !n.self && n.kind === "domain");
	if (domains.length) out.push("## Domains", "", table([["Domain", "Files", "Lines", "Language"], ["---", "---", "---", "---"], ...domains.map((d) => [d.label, d.files, d.lines, d.language ?? ""])]), "");
	const external = whole.edges.filter((edge) => edge.from === id || edge.to === id);
	if (external.length) out.push("## How it talks to other systems", "", ...external.map((edge) => `- ${edge.sentence}`), "");
	const routes = (repo.files ?? []).flatMap((file) => (file.routes ?? []).map((route) => `- \`${route.method} ${route.path}\` in \`${file.path}:${route.line}\``));
	if (routes.length) out.push("## HTTP routes served", "", ...routes.slice(0, 60), "");
	const topicLines = (repo.files ?? []).flatMap((file) => [...(file.publishes ?? []).map((t) => `- publishes \`${t.name}\` in \`${file.path}:${t.line}\``), ...(file.subscribes ?? []).map((t) => `- consumes \`${t.name}\` in \`${file.path}:${t.line}\``)]);
	if (topicLines.length) out.push("## Events", "", ...topicLines.slice(0, 60), "");
	out.push("## Map", "", "```mermaid", view.mermaid, "```", "");
	const notes = [...model.notes.entries()].filter(([target]) => chainOf(model, target).includes(id)).flatMap(([target, list]) => list.map((note) => ({ ...note, target })));
	if (notes.length) {
		out.push("## Notes", "");
		for (const note of notes.sort((a, b) => a.createdAt - b.createdAt)) out.push(`### ${model.nodes.get(note.target).path || node.label}`, "", note.text, "", `_${note.byName ?? "unknown"}, ${new Date(note.createdAt).toISOString().slice(0, 10)}_`, "");
	}
	return `${out.join("\n").trimEnd()}\n`;
}

export function workspaceMarkdown(model) {
	const view = viewGraph(model, ROOT_ID);
	const repos = view.nodes.filter((n) => n.kind === "repo");
	const out = ["# Workspace", "", table([["Repository", "Files", "Lines", "Main language"], ["---", "---", "---", "---"], ...repos.map((r) => [`[${r.label}](${r.repo}.md)`, r.files, r.lines, r.language ?? ""])]), ""];
	if (view.edges.length) out.push("## How the systems connect", "", ...view.edges.map((edge) => `- ${edge.sentence}`), "");
	out.push("## Map", "", "```mermaid", view.mermaid, "```", "");
	const notes = model.notes.get(ROOT_ID) ?? [];
	if (notes.length) out.push("## Notes", "", ...notes.map((note) => `- ${note.text} (_${note.byName ?? "unknown"}_)`), "");
	return `${out.join("\n").trimEnd()}\n`;
}
