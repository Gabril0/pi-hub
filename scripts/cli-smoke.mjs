import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");
if (!existsSync(cli)) {
	console.error("Run npm install first: the smoke test drives the real pi CLI from devDependencies.");
	process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), "pi-hub-smoke-"));
const hubDir = join(sandbox, "hub");
const agentDir = join(sandbox, "agent");
const work = join(sandbox, "work");
for (const dir of [hubDir, agentDir, work]) mkdirSync(dir, { recursive: true });
writeFileSync(join(work, "app.py"), 'def greet(name):\n    return "hi " + name\n');

const port = String(4900 + Math.floor(Math.random() * 400));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_HUB_DIR: hubDir, PI_HUB_PORT: port, PI_HUB_SILENT: "1", PI_HUB_SESSION_ID: "cli-smoke" };
const pi = spawn(process.execPath, [cli, "-e", join(root, "extension", "index.ts"), "-e", join(root, "test", "fixtures", "scripted-model.ts"), "--model", "scripted/scripted-1", "-p", "change the greeting"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
pi.stdout.on("data", (chunk) => (output += chunk));
pi.stderr.on("data", (chunk) => (output += chunk));
const exited = new Promise((resolve) => pi.on("close", resolve));

const base = `http://127.0.0.1:${port}`;
const token = () => (existsSync(join(hubDir, "token")) ? readFileSync(join(hubDir, "token"), "utf8").trim() : "");
const api = async (method, path, body) => {
	const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "x-hub-token": token() }, body: body ? JSON.stringify(body) : undefined });
	return res.json();
};

const steps = [];
let reviewId;
for (let i = 0; i < 120 && !reviewId; i++) {
	await new Promise((r) => setTimeout(r, 500));
	try {
		reviewId = (await api("GET", "/api/state")).reviews.find((r) => r.status === "pending")?.id;
	} catch {}
}
if (!reviewId) {
	pi.kill();
	console.error(`FAIL: no review reached the hub\n${output}`);
	process.exit(1);
}
const untouched = readFileSync(join(work, "app.py"), "utf8").includes('"hi "');
steps.push(`review ${reviewId} pending, file untouched: ${untouched}`);
await api("POST", `/api/reviews/${reviewId}/decision`, { decision: "approve" });
steps.push("approved through the hub API");
const code = await exited;
const after = readFileSync(join(work, "app.py"), "utf8");
const state = await api("GET", "/api/state");
await api("POST", "/api/shutdown").catch(() => {});
const review = state.reviews.find((r) => r.id === reviewId);
const ok = code === 0 && untouched && after.includes('"hello "') && review?.applied === true;
steps.push(`pi exited ${code}; file now: ${after.trim().split("\n").pop().trim()}; review applied: ${review?.applied}`);
console.log(steps.map((s) => `- ${s}`).join("\n"));
console.log(ok ? "PASS: real pi CLI edit was gated by the hub and applied after approval" : `FAIL\n${output}`);
process.exit(ok ? 0 : 1);
