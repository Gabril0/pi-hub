import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HUB_DIR = process.env.PI_HUB_DIR || join(homedir(), ".pi", "agent", "hub");
export const PORT = Number(process.env.PI_HUB_PORT || 4747);
export const HOST = "127.0.0.1";
export const STATE_FILE = join(HUB_DIR, "state.json");
export const CONFIG_FILE = join(HUB_DIR, "config.json");
export const TOKEN_FILE = join(HUB_DIR, "token");
export const LOG_FILE = join(HUB_DIR, "hub.log");

export const DEFAULT_CONFIG = {
	notifications: {
		enabled: true,
		sound: true,
		kinds: {
			review: true,
			question: true,
			done: true,
			error: true,
			message: true,
			test_fail: true,
			pr: true,
			conflict: true,
		},
	},
	review: {
		autoApprove: [],
		contextLines: 3,
	},
	summaries: {
		onAgentEnd: true,
		minTurns: 3,
	},
	prPollSeconds: 90,
	piCommand: "pi",
	openBrowserOnReview: true,
};

export function ensureHubDir() {
	mkdirSync(HUB_DIR, { recursive: true });
}

export function readToken() {
	ensureHubDir();
	if (existsSync(TOKEN_FILE)) {
		const token = readFileSync(TOKEN_FILE, "utf8").trim();
		if (token) return token;
	}
	const token = randomBytes(24).toString("hex");
	try {
		writeFileSync(TOKEN_FILE, token, { mode: 0o600, flag: "wx" });
		return token;
	} catch {
		return readFileSync(TOKEN_FILE, "utf8").trim() || token;
	}
}

export function mergeDeep(base, override) {
	if (Array.isArray(base) || typeof base !== "object" || base === null) return override ?? base;
	const out = { ...base };
	for (const [key, value] of Object.entries(override ?? {})) {
		out[key] = key in base ? mergeDeep(base[key], value) : value;
	}
	return out;
}

export function loadConfig() {
	ensureHubDir();
	if (!existsSync(CONFIG_FILE)) return structuredClone(DEFAULT_CONFIG);
	try {
		return mergeDeep(DEFAULT_CONFIG, JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config) {
	ensureHubDir();
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
