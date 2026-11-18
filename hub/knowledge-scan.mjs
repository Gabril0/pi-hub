import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";

export const LANGUAGES = {
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".kt": "kotlin",
	".rb": "ruby",
	".php": "php",
	".cs": "csharp",
	".swift": "swift",
};

const JS_FAMILY = new Set(["javascript", "typescript"]);
const HASH_COMMENTS = new Set(["python", "ruby"]);
const SKIP_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", "third_party", ".next", ".nuxt", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache", ".idea", ".vscode", "out"]);
const SECRET_FILE = /(^|\/)(\.env(\.|$)|.*\.(pem|key|p12|pfx)$|id_(rsa|ed25519)|credentials|secrets?\.)/i;
const GENERATED_FILE = /(\.min\.(js|css)$|\.d\.ts$|\.generated\.|\.pb\.go$|_pb2\.py$)/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|fixtures|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/i;
const MAX_FILE_BYTES = 512 * 1024;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;
const HTTP_METHODS = "get|post|put|patch|delete|head|options";
const STORE_ALIASES = { postgres: "postgres", postgresql: "postgres", mysql: "mysql", mongodb: "mongodb", redis: "redis", rediss: "redis", amqp: "rabbitmq", amqps: "rabbitmq", kafka: "kafka", nats: "nats", sqlite: "sqlite" };

export const STORE_PACKAGES = {
	pg: "postgres",
	postgres: "postgres",
	psycopg2: "postgres",
	psycopg: "postgres",
	"tokio-postgres": "postgres",
	mysql2: "mysql",
	mongoose: "mongodb",
	mongodb: "mongodb",
	pymongo: "mongodb",
	redis: "redis",
	ioredis: "redis",
	kafkajs: "kafka",
	rdkafka: "kafka",
	amqplib: "rabbitmq",
	lapin: "rabbitmq",
	"better-sqlite3": "sqlite",
	rusqlite: "sqlite",
};

export function languageOf(path) {
	const match = String(path).toLowerCase().match(/\.[a-z0-9]+$/);
	return match ? LANGUAGES[match[0]] : undefined;
}

export function isScannablePath(path) {
	const value = String(path).replace(/\\/g, "/");
	if (!languageOf(value) || SECRET_FILE.test(value) || GENERATED_FILE.test(value)) return false;
	return !value.split("/").some((segment) => SKIP_SEGMENTS.has(segment));
}

export function isTestPath(path) {
	return TEST_FILE.test(String(path).replace(/\\/g, "/"));
}

function lineIndex(text) {
	const starts = [0];
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
	return (offset) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (starts[mid] <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
}

function blankComments(text, language) {
	const pattern = HASH_COMMENTS.has(language) ? /^[ \t]*#.*$/gm : /^[ \t]*(?:\/\/|\/\*|\*).*$/gm;
	return text.replace(pattern, (line) => " ".repeat(line.length));
}

function matches(regex, text, visit) {
	for (const match of text.matchAll(regex)) visit(match);
}

function importedNames(clause) {
	const names = [];
	const braces = clause.match(/\{([^}]*)\}/);
	if (braces) {
		for (const part of braces[1].split(",")) {
			const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
			if (name) names.push(name);
		}
	}
	const head = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
	if (head && !head.startsWith("*")) names.push("default");
	return names;
}

function extractImports(text, language, at) {
	const imports = [];
	const add = (spec, names, index) => imports.push({ spec, names, line: at(index) });
	if (JS_FAMILY.has(language)) {
		matches(/^[ \t]*(?:import|export)\s+(?:type\s+)?([\w$*\s{},]+?)\s+from\s+["']([^"'\n]+)["']/gm, text, (m) => add(m[2], importedNames(m[1]), m.index));
		matches(/^[ \t]*import\s+["']([^"'\n]+)["']/gm, text, (m) => add(m[1], [], m.index));
		matches(/\b(?:require|import)\(\s*["']([^"'\n]+)["']\s*\)/g, text, (m) => add(m[1], [], m.index));
	} else if (language === "python") {
		matches(/^[ \t]*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm, text, (m) => add(m[1], m[2].replace(/[()]/g, "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter((n) => n && n !== "*"), m.index));
		matches(/^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm, text, (m) => {
			for (const spec of m[1].split(",")) add(spec.trim(), [], m.index);
		});
	} else if (language === "go") {
		matches(/^[ \t]*import\s+(?:\w+\s+)?"([^"\n]+)"/gm, text, (m) => add(m[1], [], m.index));
		matches(/^[ \t]*import\s*\(([\s\S]*?)^\s*\)/gm, text, (m) => {
			matches(/"([^"\n]+)"/g, m[1], (inner) => add(inner[1], [], m.index + m[0].indexOf(inner[0])));
		});
	} else if (language === "rust") {
		matches(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+?)(?:::\{([^}]*)\}|::\*)?\s*(?:as\s+\w+\s*)?;/gm, text, (m) => {
			const parts = m[1].split("::");
			const names = m[2] ? m[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].split("::")[0]).filter((n) => n && n !== "self") : [parts.at(-1)];
			add(m[2] ? m[1] : parts.slice(0, -1).join("::") || m[1], names, m.index);
		});
		matches(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm, text, (m) => add(`self::${m[1]}`, [], m.index));
	} else if (language === "java" || language === "kotlin") {
		matches(/^[ \t]*import\s+(?:static\s+)?([\w.]+)/gm, text, (m) => add(m[1], [m[1].split(".").at(-1)], m.index));
	}
	return imports;
}

function extractSymbols(text, language, at) {
	const symbols = [];
	const seen = new Set();
	const add = (name, kind, exported, index) => {
		if (!name || seen.has(name)) return;
		seen.add(name);
		symbols.push({ name, kind, exported, line: at(index) });
	};
	if (JS_FAMILY.has(language)) {
		matches(/^[ \t]*(export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([\w$]+)/gm, text, (m) => add(m[2], "function", Boolean(m[1]), m.index));
		matches(/^[ \t]*(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([\w$]+)/gm, text, (m) => add(m[2], "class", Boolean(m[1]), m.index));
		matches(/^export\s+(?:const|let|var)\s+([\w$]+)/gm, text, (m) => add(m[1], "value", true, m.index));
		matches(/^export\s+(?:interface|type|enum)\s+([\w$]+)/gm, text, (m) => add(m[1], "type", true, m.index));
	} else if (language === "python") {
		matches(/^(?:async\s+)?def\s+(\w+)/gm, text, (m) => add(m[1], "function", !m[1].startsWith("_"), m.index));
		matches(/^class\s+(\w+)/gm, text, (m) => add(m[1], "class", !m[1].startsWith("_"), m.index));
	} else if (language === "go") {
		matches(/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm, text, (m) => add(m[1], "function", /^[A-Z]/.test(m[1]), m.index));
		matches(/^type\s+(\w+)/gm, text, (m) => add(m[1], "type", /^[A-Z]/.test(m[1]), m.index));
	} else if (language === "rust") {
		matches(/^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm, text, (m) => add(m[2], "function", Boolean(m[1]), m.index));
		matches(/^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/gm, text, (m) => add(m[2], "type", Boolean(m[1]), m.index));
	} else if (language === "java" || language === "kotlin" || language === "csharp" || language === "swift") {
		matches(/^[ \t]*(public\s+)?(?:final\s+|abstract\s+|data\s+|sealed\s+)*(?:class|interface|enum|struct|object)\s+(\w+)/gm, text, (m) => add(m[2], "type", Boolean(m[1]), m.index));
	} else if (language === "ruby" || language === "php") {
		matches(/^[ \t]*(?:class|module)\s+([\w:]+)/gm, text, (m) => add(m[1], "type", true, m.index));
		matches(/^[ \t]*(?:public\s+)?(?:def|function)\s+(\w+)/gm, text, (m) => add(m[1], "function", true, m.index));
	}
	return symbols.slice(0, 200);
}

export function normalizeRoute(path) {
	let value = String(path).split(/[?#]/)[0];
	value = value.replace(/\$\{[^}]*\}|\{[^}]*\}|<[^>]*>|\[[^\]]*\]|(?<=\/):[\w-]+/g, ":p");
	value = value.replace(/\/{2,}/g, "/");
	value = value.replace(/(?<=\/)[A-Za-z0-9_-]{20,}(?=\/|$)/g, ":p");
	if (value.length > 1) value = value.replace(/\/$/, "");
	return value;
}

export function parseCallTarget(raw) {
	let value = String(raw).trim();
	let base;
	const prefix = value.match(/^(?:\$\{([^}]+)\}|\{(\w+)\})/);
	if (prefix) {
		base = (prefix[1] ?? prefix[2]).trim();
		value = value.slice(prefix[0].length);
	}
	let host;
	const absolute = value.match(/^https?:\/\/(?:[^/@\s]*@)?([^/:?#\s]+)(?::\d+)?/i);
	if (absolute) {
		if (!absolute[1].includes("$") && !absolute[1].includes("{") && !LOCAL_HOSTS.test(absolute[1])) host = absolute[1].toLowerCase();
		value = value.slice(absolute[0].length);
	}
	const path = value.startsWith("/") ? normalizeRoute(value) : undefined;
	if (!host && !path) return undefined;
	return { host, path, base };
}

function unique(items, keyOf) {
	const seen = new Set();
	return items.filter((item) => {
		const key = keyOf(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function extractRoutes(text, at) {
	const routes = [];
	const add = (method, path, index) => routes.push({ method: method ? method.toUpperCase() : "ANY", path: normalizeRoute(path), line: at(index) });
	const verbs = HTTP_METHODS;
	matches(new RegExp(`\\b(?:app|router|server|fastify|routes|r|e|g)\\.(${verbs})\\(\\s*["'\`](\\/[^"'\`\\s]*)["'\`]`, "gi"), text, (m) => add(m[1], m[2], m.index));
	matches(/\broute\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*["'`](\/[^"'`\s]*)["'`]/g, text, (m) => add(m[1], m[2], m.index));
	matches(new RegExp(`^[ \\t]*@\\w+\\.(${verbs}|route)\\(\\s*["'](\\/[^"']*)["']`, "gm"), text, (m) => add(m[1] === "route" ? undefined : m[1], m[2], m.index));
	matches(new RegExp(`\\.route\\(\\s*"(\\/[^"]*)"\\s*,\\s*(?:\\w+::)*(${verbs})\\b`, "g"), text, (m) => add(m[2], m[1], m.index));
	matches(new RegExp(`#\\[(${verbs})\\(\\s*"(\\/[^"]*)"`, "g"), text, (m) => add(m[1], m[2], m.index));
	matches(/\bHandleFunc\(\s*"(?:(GET|POST|PUT|PATCH|DELETE) )?(\/[^"]*)"/g, text, (m) => add(m[1], m[2], m.index));
	matches(/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?"(\/[^"]*)"/g, text, (m) => add(m[1] === "Request" ? undefined : m[1], m[2], m.index));
	return unique(routes, (r) => `${r.line} ${r.method} ${r.path}`);
}

function extractCalls(text, at) {
	const calls = [];
	const add = (method, raw, index) => {
		const target = parseCallTarget(raw);
		if (target) calls.push({ method: method ? method.toUpperCase() : "ANY", ...target, line: at(index) });
	};
	matches(/\bfetch\(\s*(["'`])([^"'`\n]+)\1/g, text, (m) => {
		const options = text.slice(m.index + m[0].length, m.index + m[0].length + 200).match(/^[^)]*?method:\s*["'](\w+)["']/);
		add(options?.[1] ?? "GET", m[2], m.index);
	});
	matches(new RegExp(`\\b(?:axios|requests|httpx|got|ky|superagent|client|httpClient|http|session|api)\\.(${HTTP_METHODS})\\(\\s*(["'\`])([^"'\`\\n]+)\\2`, "g"), text, (m) => add(m[1], m[3], m.index));
	matches(/\bhttp\.(Get|Post)\(\s*"([^"\n]+)"/g, text, (m) => add(m[1], m[2], m.index));
	matches(new RegExp(`\\breqwest::(${HTTP_METHODS})\\(\\s*"([^"\\n]+)"`, "g"), text, (m) => add(m[1], m[2], m.index));
	matches(/\b(?:api|call|request)\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*(["'`])([^"'`\n]+)\2/g, text, (m) => add(m[1], m[3], m.index));
	return unique(calls, (c) => `${c.line} ${c.method} ${c.host ?? ""}${c.path ?? ""}`);
}

function extractTopics(text, at) {
	const publishes = [];
	const subscribes = [];
	const pub = (name, index) => publishes.push({ name, line: at(index) });
	const sub = (name, index) => subscribes.push({ name, line: at(index) });
	matches(/\.(?:publish|sendToQueue|produce)\(\s*["'`]([\w.:/-]+)["'`]/g, text, (m) => pub(m[1], m.index));
	matches(/\bproducer\.send\(\s*\{\s*topic:\s*["']([\w.:/-]+)["']/g, text, (m) => pub(m[1], m.index));
	matches(/\.(?:subscribe|consume)\(\s*["'`]([\w.:/-]+)["'`]/g, text, (m) => sub(m[1], m.index));
	matches(/\bconsumer\.subscribe\(\s*\{\s*topics?:\s*\[?\s*["']([\w.:/-]+)["']/g, text, (m) => sub(m[1], m.index));
	matches(/@KafkaListener\(\s*topics\s*=\s*"([\w.:/-]+)"/g, text, (m) => sub(m[1], m.index));
	return { publishes, subscribes };
}

function extractStores(text, at) {
	const stores = [];
	matches(/\b(postgres(?:ql)?|mysql|mongodb|rediss?|amqps?|kafka|nats|sqlite)(?:\+\w+)?:\/\//gi, text, (m) => stores.push({ name: STORE_ALIASES[m[1].toLowerCase()], line: at(m.index) }));
	return stores;
}

function extractEnvs(text, at) {
	const envs = [];
	matches(/(?:process\.env\.|os\.environ(?:\.get\()?\[?\(?["']|os\.getenv\(["']|env::var\("|os\.Getenv\(")([A-Z][A-Z0-9_]*_(?:URL|URI|HOST|ENDPOINT|ADDR|ADDRESS))\b/g, text, (m) => envs.push({ name: m[1], line: at(m.index) }));
	return envs;
}

export function extractFacts(path, text) {
	const language = languageOf(path);
	const source = String(text ?? "");
	const lines = source ? source.split("\n").length - (source.endsWith("\n") ? 1 : 0) : 0;
	if (!language) return { language, lines, imports: [], symbols: [], routes: [], calls: [], publishes: [], subscribes: [], stores: [], envs: [], test: false };
	const code = blankComments(source, language);
	const at = lineIndex(code);
	const test = isTestPath(path);
	const topics = test ? { publishes: [], subscribes: [] } : extractTopics(code, at);
	return {
		language,
		lines,
		test,
		imports: extractImports(code, language, at),
		symbols: extractSymbols(code, language, at),
		routes: test ? [] : extractRoutes(code, at),
		calls: test ? [] : extractCalls(code, at),
		publishes: topics.publishes,
		subscribes: topics.subscribes,
		stores: test ? [] : extractStores(code, at),
		envs: test ? [] : extractEnvs(code, at),
	};
}

function packageOfSpec(spec, language) {
	if (JS_FAMILY.has(language)) {
		if (spec.startsWith("node:") || spec.startsWith("#")) return undefined;
		const parts = spec.split("/");
		return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
	}
	if (language === "python") return spec.startsWith(".") ? undefined : spec.split(".")[0];
	if (language === "rust") {
		const head = spec.split("::")[0];
		return ["std", "core", "alloc", "crate", "self", "super"].includes(head) ? undefined : head;
	}
	if (language === "go") return spec.split("/")[0].includes(".") ? spec : undefined;
	return undefined;
}

function firstExisting(candidates, files) {
	return candidates.map((c) => posix.normalize(c)).find((c) => files.has(c));
}

function resolveJs(from, spec, files) {
	if (!spec.startsWith(".")) return undefined;
	const base = posix.join(posix.dirname(from), spec);
	const stem = base.replace(/\.(m?js|cjs|jsx|ts|tsx)$/, "");
	const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs"];
	return firstExisting([base, ...extensions.map((e) => stem + e), ...extensions.map((e) => `${base}/index${e}`)], files);
}

function resolvePython(from, spec, files) {
	const dots = spec.match(/^\.*/)[0].length;
	const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
	const roots = [];
	if (dots) {
		let dir = posix.dirname(from);
		for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
		roots.push(dir);
	} else roots.push(".", "src", posix.dirname(from));
	const stems = roots.map((root) => posix.join(root, rest));
	return firstExisting(stems.flatMap((stem) => [`${stem}.py`, `${stem}/__init__.py`]), files);
}

function resolveRust(from, spec, files) {
	const parts = spec.split("::");
	const head = parts.shift();
	const moduleDir = /(^|\/)(mod|lib|main)\.rs$/.test(from) ? posix.dirname(from) : from.replace(/\.rs$/, "");
	let base;
	if (head === "crate") {
		const marker = from.lastIndexOf("src/");
		base = marker === -1 ? "src" : `${from.slice(0, marker)}src`;
	} else if (head === "self") base = moduleDir;
	else if (head === "super") {
		base = posix.dirname(moduleDir);
		while (parts[0] === "super") {
			parts.shift();
			base = posix.dirname(base);
		}
	} else return undefined;
	for (let length = parts.length; length >= 0; length--) {
		const stem = posix.join(base, ...parts.slice(0, length));
		const found = firstExisting(length ? [`${stem}.rs`, `${stem}/mod.rs`] : [`${stem}/lib.rs`, `${stem}/main.rs`, `${stem}.rs`, `${stem}/mod.rs`], files);
		if (found && found !== from) return found;
	}
	return undefined;
}

function resolveJvm(spec, files) {
	const stem = spec.split(".").join("/");
	for (const file of files) if (file.endsWith(`${stem}.java`) || file.endsWith(`${stem}.kt`)) return file;
	return undefined;
}

export function resolveImports(path, facts, files, manifest = {}) {
	const dirs = new Set([...files].map((f) => posix.dirname(f)));
	const resolved = [];
	for (const item of facts.imports) {
		const { spec, names, line } = item;
		let file;
		let dir;
		if (JS_FAMILY.has(facts.language)) file = resolveJs(path, spec, files);
		else if (facts.language === "python") file = resolvePython(path, spec, files);
		else if (facts.language === "rust") file = resolveRust(path, spec, files);
		else if (facts.language === "java" || facts.language === "kotlin") file = resolveJvm(spec, files);
		else if (facts.language === "go" && manifest.goModule && (spec === manifest.goModule || spec.startsWith(`${manifest.goModule}/`))) {
			const relative = spec.slice(manifest.goModule.length + 1) || ".";
			if (dirs.has(relative)) dir = relative;
		}
		if (file && file !== path) resolved.push({ file, names, line });
		else if (dir) resolved.push({ dir, names, line });
		else if (!file) {
			const pkg = packageOfSpec(spec, facts.language);
			if (pkg) resolved.push({ pkg, names, line });
		}
	}
	return resolved;
}

function tomlSection(text, name) {
	const header = text.match(new RegExp(`^\\[${name.replace(/[.]/g, "\\.")}\\]\\s*$`, "m"));
	if (!header) return "";
	const rest = text.slice(header.index + header[0].length);
	const next = rest.search(/^\[/m);
	return next === -1 ? rest : rest.slice(0, next);
}

function tomlKeys(section) {
	return [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
}

export function parseManifests(read) {
	const manifest = { names: [], deps: [], description: "" };
	const pkg = read("package.json");
	if (pkg) {
		try {
			const json = JSON.parse(pkg);
			if (json.name) manifest.names.push(json.name);
			manifest.description ||= json.description ?? "";
			manifest.deps.push(...Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies }));
		} catch {}
	}
	const cargo = read("Cargo.toml");
	if (cargo) {
		const name = tomlSection(cargo, "package").match(/^name\s*=\s*"([^"]+)"/m);
		if (name) manifest.names.push(name[1]);
		const description = tomlSection(cargo, "package").match(/^description\s*=\s*"([^"]+)"/m);
		manifest.description ||= description?.[1] ?? "";
		manifest.deps.push(...tomlKeys(tomlSection(cargo, "dependencies")), ...tomlKeys(tomlSection(cargo, "workspace.dependencies")));
	}
	const goMod = read("go.mod");
	if (goMod) {
		const module = goMod.match(/^module\s+(\S+)/m);
		if (module) {
			manifest.goModule = module[1];
			manifest.names.push(module[1]);
		}
		for (const m of goMod.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/\S+)\s+v\d/gm)) manifest.deps.push(m[1]);
	}
	const pyproject = read("pyproject.toml");
	if (pyproject) {
		const name = tomlSection(pyproject, "project").match(/^name\s*=\s*"([^"]+)"/m);
		if (name) manifest.names.push(name[1]);
		const description = tomlSection(pyproject, "project").match(/^description\s*=\s*"([^"]+)"/m);
		manifest.description ||= description?.[1] ?? "";
		const deps = tomlSection(pyproject, "project").match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
		if (deps) for (const m of deps[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) manifest.deps.push(m[1]);
	}
	const requirements = read("requirements.txt");
	if (requirements) for (const m of requirements.matchAll(/^([A-Za-z0-9_.-]+)/gm)) manifest.deps.push(m[1]);
	manifest.deps = [...new Set(manifest.deps)];
	return manifest;
}

export function readmeSummary(text) {
	if (!text) return "";
	const paragraphs = text.replace(/\r/g, "").split(/\n{2,}/).map((p) => p.trim());
	const first = paragraphs.find((p) => p && !/^(#|!\[|\[!|<|\||```|---)/.test(p));
	if (!first) return "";
	const plain = first.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ");
	return plain.length > 240 ? `${plain.slice(0, 239)}…` : plain;
}

function run(command, args, cwd) {
	return new Promise((resolve) => {
		execFile(command, args, { cwd, timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout));
	});
}

function walk(root, limit) {
	const out = [];
	const stack = [""];
	while (stack.length && out.length < limit) {
		const dir = stack.pop();
		let entries = [];
		try {
			entries = readdirSync(join(root, dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (!SKIP_SEGMENTS.has(entry.name) && !entry.name.startsWith(".")) stack.push(rel);
			} else if (entry.isFile()) out.push(rel);
		}
	}
	return out;
}

async function listFiles(root, limit) {
	const output = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
	if (output !== undefined) return output.split("\0").filter(Boolean);
	return walk(root, limit * 5);
}

export async function canonicalRepoRoot(path) {
	const common = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
	const value = common?.trim().replace(/\\/g, "/");
	if (value?.endsWith("/.git")) {
		const root = value.slice(0, -5);
		if (existsSync(root)) return root;
	}
	const top = await run("git", ["rev-parse", "--show-toplevel"], path);
	return top?.trim() || path;
}

export async function scanRepo(root, { maxFiles = 4000, isCancelled = () => false } = {}) {
	const listed = await listFiles(root, maxFiles);
	const candidates = listed.filter(isScannablePath).sort();
	const chosen = candidates.slice(0, maxFiles);
	const paths = new Set();
	const raw = [];
	for (const [index, path] of chosen.entries()) {
		if (isCancelled()) return undefined;
		if (index % 40 === 39) await new Promise((resolve) => setImmediate(resolve));
		const absolute = join(root, path);
		try {
			const info = lstatSync(absolute);
			if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
			const text = readFileSync(absolute, "utf8");
			if (text.includes("\0")) continue;
			raw.push({ path, facts: extractFacts(path, text) });
			paths.add(path);
		} catch {}
	}
	const readRoot = (name) => {
		try {
			const absolute = join(root, name);
			return lstatSync(absolute).isFile() ? readFileSync(absolute, "utf8") : undefined;
		} catch {
			return undefined;
		}
	};
	const manifest = parseManifests(readRoot);
	const languages = {};
	const files = raw.map(({ path, facts }) => {
		languages[facts.language] = (languages[facts.language] ?? 0) + 1;
		const { imports: _imports, ...rest } = facts;
		return { path, ...rest, imports: resolveImports(path, facts, paths, manifest) };
	});
	return {
		root,
		name: basename(root.replace(/[\\/]+$/, "")),
		description: manifest.description || readmeSummary(readRoot("README.md")),
		manifest,
		languages,
		files,
		truncated: candidates.length > maxFiles,
		scannedAt: Date.now(),
	};
}
