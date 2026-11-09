import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_VERSION } from "../hub/version.mjs";

export const HUB_DIR = process.env.PI_HUB_DIR || join(homedir(), ".pi", "agent", "hub");
export const HUB_PORT = Number(process.env.PI_HUB_PORT || 4747);
export const HUB_BASE = `http://127.0.0.1:${HUB_PORT}`;

const SERVER_SCRIPT = fileURLToPath(new URL("../hub/server.mjs", import.meta.url));

export type ChannelMessage = { type: string; [key: string]: any };

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms).unref?.());
}

function nodeExecutable(): string {
	const exe = basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(exe)) return process.execPath;
	return "node";
}

export class HubClient {
	private token = "";
	private readyPromise: Promise<boolean> | undefined;
	private channelAbort: AbortController | undefined;
	private stopped = false;
	private versionChecked = false;
	private queue: any[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	connected = false;

	constructor(
		private readonly sessionId: string,
		private readonly onMessage: (message: ChannelMessage) => void,
		private readonly onReconnect: () => Promise<void>,
	) {}

	get base() {
		return HUB_BASE;
	}

	get browserUrl() {
		return `${HUB_BASE}/?token=${this.token}`;
	}

	private loadToken() {
		const file = join(HUB_DIR, "token");
		if (existsSync(file)) this.token = readFileSync(file, "utf8").trim();
	}

	private async health(): Promise<{ build?: string; version?: number } | undefined> {
		try {
			const res = await fetch(`${HUB_BASE}/api/health`, { signal: AbortSignal.timeout(800) });
			return res.ok ? ((await res.json()) as { build?: string; version?: number }) : undefined;
		} catch {
			return undefined;
		}
	}

	private async healthy(): Promise<boolean> {
		return Boolean(await this.health());
	}

	private async replaceOutdatedHub() {
		if (this.versionChecked) return;
		const status = await this.health();
		if (!status) return;
		this.versionChecked = true;
		if ((status.version ?? 0) >= HUB_VERSION) return;
		this.loadToken();
		try {
			await fetch(`${HUB_BASE}/api/shutdown`, { method: "POST", headers: { "x-hub-token": this.token }, signal: AbortSignal.timeout(1500) });
		} catch {}
		for (let i = 0; i < 20 && (await this.healthy()); i++) await sleep(100);
	}

	private startServer() {
		mkdirSync(HUB_DIR, { recursive: true });
		const log = openSync(join(HUB_DIR, "hub.stdout.log"), "a");
		const child = spawn(nodeExecutable(), [SERVER_SCRIPT], {
			detached: true,
			stdio: ["ignore", log, log],
			windowsHide: true,
			env: { ...process.env, PI_HUB_DIR: HUB_DIR, PI_HUB_PORT: String(HUB_PORT) },
		});
		child.on("error", () => {});
		child.unref();
		closeSync(log);
	}

	ready(): Promise<boolean> {
		if (!this.readyPromise) {
			this.readyPromise = (async () => {
				if (process.env.PI_HUB_NO_RESTART !== "1") await this.replaceOutdatedHub();
				if (!(await this.healthy())) {
					this.startServer();
					for (let i = 0; i < 40 && !(await this.healthy()); i++) await sleep(150);
				}
				this.loadToken();
				const ok = Boolean(this.token) && (await this.healthy());
				if (!ok) this.readyPromise = undefined;
				return ok;
			})();
		}
		return this.readyPromise;
	}

	async request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		if (!(await this.ready())) throw new Error("pi hub unavailable");
		const res = await fetch(`${HUB_BASE}${path}`, {
			method,
			headers: { "content-type": "application/json", "x-hub-token": this.token },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
		const data = (await res.json().catch(() => ({}))) as any;
		if (!res.ok) throw Object.assign(new Error(data?.error ?? `hub ${res.status}`), { status: res.status });
		return data as T;
	}

	post<T = any>(path: string, body?: unknown, signal?: AbortSignal) {
		return this.request<T>("POST", path, body ?? {}, signal);
	}

	get<T = any>(path: string) {
		return this.request<T>("GET", path);
	}

	event(event: Record<string, unknown>) {
		this.queue.push(event);
		if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500);
		if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 250);
	}

	async flush() {
		this.flushTimer = undefined;
		if (!this.queue.length) return;
		const events = this.queue;
		this.queue = [];
		try {
			await this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/events`, { events });
		} catch {
			if (!this.stopped) this.queue.unshift(...events.slice(-200));
		}
	}

	async openChannel(register: () => Promise<void>) {
		this.stopped = false;
		let delay = 500;
		while (!this.stopped) {
			try {
				const controller = new AbortController();
				this.channelAbort = controller;
				await register();
				if (this.stopped || controller.signal.aborted) break;
				const res = await fetch(`${HUB_BASE}/api/sessions/${encodeURIComponent(this.sessionId)}/channel`, {
					headers: { "x-hub-token": this.token, accept: "text/event-stream" },
					signal: controller.signal,
				});
				if (!res.ok || !res.body) throw new Error(`channel ${res.status}`);
				this.connected = true;
				delay = 500;
				void this.onReconnect().catch(() => {});
				void this.flush();
				const decoder = new TextDecoder();
				let buffer = "";
				for await (const chunk of res.body as any) {
					buffer += decoder.decode(chunk, { stream: true });
					let index = buffer.indexOf("\n\n");
					while (index !== -1) {
						const frame = buffer.slice(0, index);
						buffer = buffer.slice(index + 2);
						const data = frame
							.split("\n")
							.filter((line) => line.startsWith("data:"))
							.map((line) => line.slice(5).trimStart())
							.join("\n");
						if (data) {
							try {
								this.onMessage(JSON.parse(data));
							} catch {}
						}
						index = buffer.indexOf("\n\n");
					}
				}
			} catch {}
			this.connected = false;
			if (this.stopped) break;
			this.readyPromise = undefined;
			await sleep(delay);
			delay = Math.min(delay * 2, 5000);
		}
	}

	async close() {
		this.stopped = true;
		await this.flush().catch(() => {});
		this.channelAbort?.abort();
	}
}
