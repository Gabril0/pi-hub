import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

const hasCommandCache = new Map();

export function hasCommand(command) {
	if (hasCommandCache.has(command)) return hasCommandCache.get(command);
	const probe = platform() === "win32" ? spawnSync("where", [command], { windowsHide: true }) : spawnSync("sh", ["-c", `command -v ${command}`]);
	const found = probe.status === 0;
	hasCommandCache.set(command, found);
	return found;
}

function run(command, args) {
	try {
		const child = spawn(command, args, { stdio: "ignore", windowsHide: true, detached: false });
		child.on("error", () => {});
		child.unref();
	} catch {}
}

function escapeXml(text) {
	return String(text).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}

const WINDOWS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

export function windowsToastScript(title, body, url, sound) {
	const audio = sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>';
	const launch = url ? ` activationType="protocol" launch="${escapeXml(url)}"` : "";
	const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual>${audio}</toast>`;
	return [
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
		"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
		`$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml, "utf8").toString("base64")}')))`,
		"$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
		"$toast.Tag = 'pi-hub'",
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast)`,
	].join("\n");
}

export function notifyCommand({ title, body, url, sound = true }, os = platform()) {
	if (os === "darwin") {
		if (hasCommand("terminal-notifier")) {
			const args = ["-title", title, "-message", body || " ", "-group", "pi-hub"];
			if (url) args.push("-open", url);
			if (sound) args.push("-sound", "Glass");
			return ["terminal-notifier", args];
		}
		const script = sound
			? 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run'
			: "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run";
		return ["osascript", ["-e", script, title, body || " "]];
	}
	if (os === "win32") {
		const encoded = Buffer.from(windowsToastScript(title, body, url, sound), "utf16le").toString("base64");
		return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]];
	}
	return ["notify-send", ["-a", "pi hub", "-i", "dialog-information", title, body || " "]];
}

export function createNotifier(getConfig, hubUrl) {
	let last = 0;
	let queued = [];
	let timer = null;

	function flush() {
		timer = null;
		const items = queued;
		queued = [];
		if (!items.length) return;
		const config = getConfig().notifications;
		const first = items[0];
		const title = items.length === 1 ? first.title : `${items.length} agent updates`;
		const body = items.length === 1 ? first.body : items.map((i) => `• ${i.title}`).join("\n");
		const url = items.length === 1 && first.path ? `${hubUrl()}${first.path}` : hubUrl();
		const [command, args] = notifyCommand({ title, body: truncate(body, 240), url, sound: config.sound });
		if (process.platform !== "win32" && process.platform !== "darwin" && !hasCommand("notify-send")) return;
		run(command, args);
		last = Date.now();
	}

	return function notify(item) {
		const config = getConfig().notifications;
		if (!config.enabled || config.kinds[item.kind] === false) return;
		if (process.env.PI_HUB_SILENT) return;
		queued.push(item);
		if (timer) return;
		const wait = Math.max(0, 1500 - (Date.now() - last));
		timer = setTimeout(flush, Math.max(wait, 400));
	};
}

function truncate(text, max) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
