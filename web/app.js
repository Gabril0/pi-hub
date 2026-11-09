import { html, render, useEffect, useState } from "./vendor/preact-htm.js";
import { connect, onInboxItem, openInbox, pendingReviews, sessionOf, sorted, useStore } from "./lib/store.js";
import { Modal, SessionChip, colorOf, isTyping, navigate, sessionName, useRoute, useTick } from "./lib/util.js";
import { chime } from "./lib/sound.js";
import { Icon } from "./lib/icons.js";
import { InboxView } from "./views/inbox.js";
import { AgentsView, AgentDetail, SpawnDialog, BroadcastDialog } from "./views/agents.js";
import { ReviewView, ReviewsView } from "./views/review.js";
import { TestsView } from "./views/tests.js";
import { TasksView } from "./views/tasks.js";
import { PrsView } from "./views/prs.js";
import { ResultsView } from "./views/results.js";
import { SettingsView } from "./views/settings.js";

const NAV = [
	{ name: "inbox", label: "Inbox", icon: "inbox", key: "1" },
	{ name: "reviews", label: "Diff review", icon: "diff", key: "2" },
	{ name: "agents", label: "Agents", icon: "agents", key: "3" },
	{ name: "tests", label: "Tests", icon: "tests", key: "4" },
	{ name: "tasks", label: "Tasks", icon: "tasks", key: "5" },
	{ name: "prs", label: "Pull requests", icon: "pr", key: "6" },
	{ name: "results", label: "Results", icon: "results", key: "7" },
	{ name: "settings", label: "Settings", icon: "settings", key: "8" },
];


function Clock() {
	useTick(1000);
	const now = new Date();
	return html`<div class="clock-pod">
		<div class="clock-time">${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
		<div class="clock-date">${now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</div>
	</div>`;
}

function Toasts() {
	const [toasts, setToasts] = useState([]);
	const state = useStore();
	useEffect(
		() =>
			onInboxItem((item) => {
				const toast = { ...item, toastId: Math.random() };
				setToasts((list) => [...list.slice(-3), toast]);
				setTimeout(() => setToasts((list) => list.filter((t) => t.toastId !== toast.toastId)), 7000);
				const prefs = state.config?.notifications;
				if (prefs?.enabled === false || prefs?.kinds?.[item.kind] === false) return;
				if (prefs?.sound !== false) chime(item.kind);
				if (document.hidden && "Notification" in window && Notification.permission === "granted") {
					const session = sessionOf(item.sessionId);
					const n = new Notification(`${session ? `[${sessionName(session)}] ` : ""}${item.title}`, { body: item.body ?? "", tag: item.id, icon: "/favicon.svg" });
					n.onclick = () => {
						focus();
						navigate(item.path ?? "#/inbox");
					};
				}
			}),
		[],
	);
	return html`<div class="toast-stack">
		${toasts.map((t) => {
			const session = sessionOf(t.sessionId);
			return html`<div class="card glossy toast" style=${`--c:${colorOf(session)}`} onClick=${() => navigate(t.path ?? "#/inbox")}>
				<div class="accent-bar"></div>
				<div class="row small faint"><${Icon} name=${t.kind} size=${13} /> ${session ? sessionName(session) : "hub"}</div>
				<div style="font-weight:700;margin-top:2px">${t.title}</div>
				${t.body ? html`<div class="small muted ellipsis">${t.body}</div>` : null}
			</div>`;
		})}
	</div>`;
}

function Shell() {
	const state = useStore();
	const route = useRoute();
	const [dialog, setDialog] = useState(null);
	const inbox = openInbox();
	const reviews = pendingReviews();
	const sessions = sorted(state.sessions, "createdAt", false);
	const online = sessions.filter((s) => s.online);
	const failing = [...state.testRuns.values()].filter((r) => r.status === "failed" && Date.now() - (r.createdAt ?? 0) < 3600_000).length;
	const openTasks = [...state.tasks.values()].filter((t) => t.status !== "done").length;
	const badges = { inbox: inbox.length, reviews: reviews.length, agents: online.length, tests: failing, tasks: openTasks };
	const urgent = { inbox: true, reviews: true, tests: true };

	useEffect(() => {
		const count = inbox.length;
		document.title = count ? `(${count}) pi hub` : "pi hub";
	}, [inbox.length]);

	useEffect(() => {
		const onKey = (e) => {
			if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
			if (route.name === "review" && route.id) return;
			const nav = NAV.find((n) => n.key === e.key);
			if (nav) navigate(`#/${nav.name}`);
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [route.name, route.id]);

	useEffect(() => {
		if ("Notification" in window && Notification.permission === "default") {
			const ask = () => Notification.requestPermission();
			addEventListener("click", ask, { once: true });
		}
	}, []);

	let view;
	switch (route.name) {
		case "review":
			view = route.id ? html`<${ReviewView} id=${route.id} key=${route.id} />` : html`<${ReviewsView} />`;
			break;
		case "reviews":
			view = html`<${ReviewsView} />`;
			break;
		case "agents":
			view = route.id ? html`<${AgentDetail} id=${route.id} key=${route.id} />` : html`<${AgentsView} />`;
			break;
		case "tests":
			view = html`<${TestsView} id=${route.id} />`;
			break;
		case "tasks":
			view = html`<${TasksView} />`;
			break;
		case "prs":
			view = html`<${PrsView} />`;
			break;
		case "results":
			view = html`<${ResultsView} id=${route.id} />`;
			break;
		case "settings":
			view = html`<${SettingsView} />`;
			break;
		default:
			view = html`<${InboxView} />`;
	}

	if (state.authError) {
		return html`<div class="empty" style="padding-top:20vh">
			<div class="empty-orb">π</div>
			<h2>Open the hub from pi</h2>
			<p class="muted">Run <code>/hub</code> inside a pi session, or open the link with <code>?token=…</code> from <code>~/.pi/agent/hub/token</code>.</p>
		</div>`;
	}

	return html`<div class="shell">
		<header class="topbar">
			<div class="brand">
				<div class="orb">π</div>
				<div class="brand-text">
					<div class="brand-name">pi hub</div>
					<div class="brand-sub">${online.length} agent${online.length === 1 ? "" : "s"} online</div>
				</div>
			</div>
			<${Clock} />
			<div class="session-strip">
				${sessions
					.filter((s) => s.online || Date.now() - (s.lastSeen ?? 0) < 6 * 3600_000)
					.map((s) => html`<${SessionChip} session=${s} showStatus=${true} on=${route.name === "agents" && route.id === s.id} onClick=${() => navigate(`#/agents/${encodeURIComponent(s.id)}`)} />`)}
			</div>
			<button class="btn sm" onClick=${() => setDialog("broadcast")} title="Message every online agent"><${Icon} name="broadcast" size=${14} />Broadcast</button>
			<button class="btn sm primary" onClick=${() => setDialog("spawn")}><${Icon} name="plus" size=${14} />New agent</button>
			<div class="link-led"><span class=${`led ${state.connected ? "on" : ""}`}></span>${state.connected ? "live" : state.loaded ? "reconnecting" : "connecting"}</div>
		</header>
		<nav class="rail">
			<div class="rail-section">Mission control</div>
			${NAV.map(
				(item) => html`<a class=${`nav-item ${route.name === item.name || (item.name === "reviews" && route.name === "review") ? "active" : ""}`} href=${`#/${item.name}`}>
					<span class="nav-icon"><${Icon} name=${item.icon} /></span>${item.label}
					${badges[item.name] ? html`<span class=${`nav-badge ${urgent[item.name] ? "" : "calm"}`}>${badges[item.name]}</span>` : null}
				</a>`,
			)}
			<div class="rail-section">Pending reviews</div>
			${reviews.slice(0, 8).map(
				(r) => html`<a class="list-row" style=${`--c:${colorOf(r.sessionId)}`} href=${`#/review/${r.id}`}>
					<span class="dot" style=${`--c:${colorOf(r.sessionId)}`}></span>
					<span class="ellipsis small">${r.path.split("/").pop()}</span>
				</a>`,
			)}
			${reviews.length ? null : html`<div class="tiny faint" style="padding:0 6px">Nothing waiting on you ✦</div>`}
		</nav>
		<main class="main">${view}</main>
		<${Toasts} />
		${dialog === "spawn" ? html`<${Modal} onClose=${() => setDialog(null)}><${SpawnDialog} onClose=${() => setDialog(null)} /><//>` : null}
		${dialog === "broadcast" ? html`<${Modal} onClose=${() => setDialog(null)}><${BroadcastDialog} onClose=${() => setDialog(null)} /><//>` : null}
	</div>`;
}

connect();
render(html`<${Shell} />`, document.getElementById("app"));
