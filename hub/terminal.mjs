import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { hasCommand } from "./notify.mjs";

const MAC_APPS = {
	ghostty: "Ghostty",
	"iTerm.app": "iTerm",
	Apple_Terminal: "Terminal",
	WezTerm: "WezTerm",
	vscode: "Visual Studio Code",
	kitty: "kitty",
	alacritty: "Alacritty",
};

function fire(command, args, options = {}) {
	return new Promise((resolve) => {
		try {
			const child = spawn(command, args, { stdio: "ignore", windowsHide: true, ...options });
			child.on("error", () => resolve(false));
			child.on("exit", (code) => resolve(code === 0));
			if (options.detached) {
				child.unref();
				resolve(true);
			}
		} catch {
			resolve(false);
		}
	});
}

function tmuxArgs(session, ...rest) {
	const socket = session?.tmuxSocket;
	return socket ? ["-S", socket, ...rest] : rest;
}

export function openBrowser(url) {
	const os = platform();
	if (os === "darwin") return fire("open", [url]);
	if (os === "win32") return fire("rundll32", ["url.dll,FileProtocolHandler", url]);
	return fire("xdg-open", [url]);
}

export async function focusSession(session) {
	const steps = [];
	if (session.tmuxPane && hasCommand("tmux")) {
		await fire("tmux", tmuxArgs(session, "switch-client", "-t", session.tmuxPane));
		await fire("tmux", tmuxArgs(session, "select-window", "-t", session.tmuxPane));
		const ok = await fire("tmux", tmuxArgs(session, "select-pane", "-t", session.tmuxPane));
		steps.push(ok ? "tmux pane selected" : "tmux select failed");
	}
	const os = platform();
	if (os === "darwin") {
		const app = MAC_APPS[session.termProgram] ?? (session.termProgram ? session.termProgram : "Ghostty");
		const ok = await fire("osascript", ["-e", `tell application "${app.replace(/"/g, "")}" to activate`]);
		steps.push(ok ? `${app} focused` : `${app} focus failed`);
	} else if (os === "win32" && session.pid) {
		const script = [
			"$shell = New-Object -ComObject WScript.Shell",
			`$id = ${Number(session.pid)}`,
			"for ($i = 0; $i -lt 8 -and $id; $i++) {",
			"  if ($shell.AppActivate([int]$id)) { exit 0 }",
			"  $id = (Get-CimInstance Win32_Process -Filter \"ProcessId=$id\").ParentProcessId",
			"}",
			"exit 1",
		].join("\n");
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const ok = await fire("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
		steps.push(ok ? "window focused" : "window focus failed");
	} else if (os === "linux" && hasCommand("wmctrl") && session.termProgram) {
		const ok = await fire("wmctrl", ["-x", "-a", session.termProgram]);
		steps.push(ok ? "window focused" : "window focus failed");
	}
	return steps;
}

export function tmuxServerRunning(socket) {
	if (!hasCommand("tmux")) return false;
	const result = spawnSync("tmux", socket ? ["-S", socket, "list-sessions"] : ["list-sessions"], { stdio: "ignore" });
	return result.status === 0;
}

export function spawnPlan({ cwd, prompt, name, piCommand = "pi", tmuxSocket, termProgram }, os = platform(), tmuxAvailable = tmuxServerRunning(tmuxSocket)) {
	const piArgs = prompt ? [prompt] : [];
	if (os !== "win32" && tmuxAvailable) {
		const base = tmuxSocket ? ["-S", tmuxSocket] : [];
		return { command: "tmux", args: [...base, "new-window", "-c", cwd, "-n", name || "pi", piCommand, ...piArgs], via: "tmux" };
	}
	if (os === "darwin") {
		if (termProgram === "ghostty" || !termProgram) {
			return { command: "open", args: ["-na", "Ghostty", "--args", `--working-directory=${cwd}`, "-e", piCommand, ...piArgs], via: "ghostty" };
		}
		const line = `cd ${shellQuote(cwd)} && ${[piCommand, ...piArgs].map(shellQuote).join(" ")}`;
		return { command: "osascript", args: ["-e", "on run argv", "-e", 'tell application "Terminal" to do script (item 1 of argv)', "-e", "end run", line], via: "terminal" };
	}
	if (os === "win32") {
		if (hasCommand("wt")) {
			const escaped = piArgs.map((arg) => arg.replace(/;/g, "\\;"));
			return { command: "wt", args: ["-w", "0", "nt", "-d", cwd, "--title", name || "pi", "cmd", "/k", piCommand, ...escaped], via: "windows-terminal" };
		}
		const quoted = [piCommand, ...piArgs].map((arg) => `"${arg.replace(/"/g, '""')}"`).join(" ");
		return { command: "cmd", args: ["/c", `start "${(name || "pi").replace(/"/g, "")}" /D "${cwd}" cmd /k ${quoted}`], via: "cmd", verbatim: true };
	}
	if (hasCommand("gnome-terminal")) return { command: "gnome-terminal", args: [`--working-directory=${cwd}`, "--", piCommand, ...piArgs], via: "gnome-terminal" };
	if (hasCommand("konsole")) return { command: "konsole", args: ["--workdir", cwd, "-e", piCommand, ...piArgs], via: "konsole" };
	return { command: "x-terminal-emulator", args: ["-e", piCommand, ...piArgs], via: "x-terminal-emulator", cwd };
}

export async function spawnAgent(options) {
	const plan = spawnPlan(options);
	const ok = await fire(plan.command, plan.args, { cwd: plan.cwd ?? options.cwd, detached: true, windowsVerbatimArguments: Boolean(plan.verbatim) });
	return { ok, via: plan.via };
}

function shellQuote(value) {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
