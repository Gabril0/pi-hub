import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { buildProposal, diffStats, type Proposal, rewriteInputForContent } from "./edits";
import { type ChannelMessage, HubClient } from "./hub-client";
import { answerReviewQuestion, formatLineComments, type LineComment, reviseProposal, summarizeSession } from "./llm";
import { isTestCommand } from "../hub/test-parsers.mjs";

interface PendingReview {
	id: string;
	toolCallId: string;
	proposal: Proposal;
	chat: Array<{ role: string; text: string }>;
	latest: string;
	ctx: ExtensionContext;
	abort: AbortController;
	resolve: (decision: ReviewDecision) => void;
}

interface ReviewDecision {
	decision: "approved" | "denied" | "cancelled";
	comment?: string;
	lineComments?: LineComment[];
	content?: string;
}

interface PendingQuestion {
	resolve: (answer: string | undefined) => void;
	question: string;
	options: string[];
}

function detectTerminal(): string | undefined {
	const env = process.env;
	if (env.TERM_PROGRAM && env.TERM_PROGRAM !== "tmux") return env.TERM_PROGRAM;
	if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (env.ITERM_SESSION_ID) return "iTerm.app";
	if (env.WEZTERM_PANE) return "WezTerm";
	if (env.KITTY_WINDOW_ID) return "kitty";
	if (env.ALACRITTY_SOCKET || env.ALACRITTY_LOG) return "alacritty";
	if (env.WT_SESSION) return "WindowsTerminal";
	return env.TERM_PROGRAM;
}

function sessionKey(): string {
	if (process.env.PI_HUB_SESSION_ID) return process.env.PI_HUB_SESSION_ID;
	const host = hostname().split(".")[0].toLowerCase();
	if (process.env.TMUX_PANE) return `${host}-tmux${process.env.TMUX_PANE.replace(/[^\w]/g, "")}`;
	return `${host}-pid${process.pid}`;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 4000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
	});
}

function hexToAnsi(hex: string): string {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

function textOf(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function toolSummary(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return toolName;
	if (toolName === "bash") return String(args.command ?? "");
	if (typeof args.path === "string") return args.path;
	if (typeof args.pattern === "string") return args.pattern;
	try {
		return JSON.stringify(args).slice(0, 200);
	} catch {
		return toolName;
	}
}

export function formatDenial(path: string, decision: ReviewDecision): string {
	const lines = [`The user rejected your ${path} change in the diff reviewer. It was NOT applied.`];
	if (decision.comment?.trim()) lines.push(`Reviewer feedback: ${decision.comment.trim()}`);
	const comments = formatLineComments(decision.lineComments);
	if (comments) lines.push(`Line comments:\n${comments}`);
	if (!decision.comment?.trim() && !comments) lines.push("No reason was given. Do not retry the same change; ask the user what they want instead.");
	else lines.push("Address the feedback before proposing a new change to this file.");
	return lines.join("\n");
}

export default function piHub(pi: ExtensionAPI) {
	const id = sessionKey();
	const pendingReviews = new Map<string, PendingReview>();
	const pendingQuestions = new Map<string, PendingQuestion>();
	const reviewByToolCall = new Map<string, string>();
	let latestCtx: ExtensionContext | undefined;
	let gateEnabled = process.env.PI_HUB_GATE !== "0";
	let trust: "review" | "auto" = "review";
	let color: { name: string; hex: string } | undefined;
	let lastPrompt = "";
	let runFiles = new Set<string>();
	let channelStarted = false;
	let summaryConfig = { onAgentEnd: true, minTurns: 3 };
	let runTurns = 0;

	const client = new HubClient(id, (message) => handleChannel(message), async () => resync());

	async function sessionInfo(ctx: ExtensionContext) {
		const cwd = ctx.cwd;
		const [top, branch] = await Promise.all([git(cwd, ["rev-parse", "--show-toplevel"]), git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])]);
		return {
			id,
			name: pi.getSessionName() || undefined,
			cwd,
			repo: top ? basename(top) : basename(cwd),
			repoRoot: top,
			isGitRepo: Boolean(top),
			branch,
			pid: process.pid,
			host: hostname(),
			platform: process.platform,
			tmuxPane: process.env.TMUX_PANE,
			tmuxSocket: process.env.TMUX?.split(",")[0],
			termProgram: detectTerminal(),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			sessionFile: ctx.sessionManager.getSessionFile(),
			piSessionId: ctx.sessionManager.getSessionId(),
		};
	}

	function renderStatus() {
		const ctx = latestCtx;
		try {
			if (ctx?.hasUI) renderFooter(ctx);
		} catch {}
	}

	function renderFooter(ctx: ExtensionContext) {
		const dot = color ? `${hexToAnsi(color.hex)}●\x1b[0m` : "○";
		const pending = pendingReviews.size ? ` · ${pendingReviews.size} review${pendingReviews.size > 1 ? "s" : ""} pending` : "";
		const mode = !gateEnabled ? " · gate off" : trust === "auto" ? " · auto-approve" : "";
		const link = client.connected ? "" : " · offline";
		ctx.ui.setStatus("pi-hub", `${dot} hub ${color?.name ?? ""}${mode}${pending}${link}`);
	}

	async function register() {
		if (!latestCtx) return;
		let info;
		try {
			info = await sessionInfo(latestCtx);
		} catch {
			return;
		}
		const { session } = await client.post("/api/sessions/register", info);
		color = session.color;
		trust = session.trust ?? "review";
		try {
			const agentConfig = await client.get("/api/agent-config");
			summaryConfig = agentConfig.summaries ?? summaryConfig;
		} catch {}
		renderStatus();
	}

	async function resync() {
		for (const [reviewId, pending] of pendingReviews) {
			try {
				const { review } = await client.get(`/api/reviews/${reviewId}`);
				if (review.status === "approved") pending.resolve({ decision: "approved", content: review.finalContent, comment: review.comment });
				else if (review.status === "denied") pending.resolve({ decision: "denied", comment: review.comment, lineComments: review.lineComments });
				else if (review.status === "stale" || review.status === "cancelled") await recreateReview(reviewId, pending);
			} catch (error: any) {
				if (error?.status === 404) await recreateReview(reviewId, pending).catch(() => {});
			}
		}
		for (const [questionId, pending] of [...pendingQuestions]) {
			try {
				const { item } = await client.get(`/api/inbox/${questionId}`);
				if (item.resolved && typeof item.answer === "string") pending.resolve(item.answer);
				else if (item.resolved) await recreateQuestion(questionId, pending);
			} catch (error: any) {
				if (error?.status === 404) await recreateQuestion(questionId, pending).catch(() => {});
			}
		}
		renderStatus();
	}

	async function recreateQuestion(oldId: string, pending: PendingQuestion) {
		const created = await client.post("/api/questions", { sessionId: id, question: pending.question, options: pending.options });
		pendingQuestions.delete(oldId);
		pendingQuestions.set(created.id, pending);
	}

	async function recreateReview(oldId: string, pending: PendingReview) {
		const created = await client.post("/api/reviews", {
			sessionId: id,
			toolCallId: pending.toolCallId,
			tool: pending.proposal.tool,
			path: pending.proposal.path,
			absPath: pending.proposal.absPath,
			isNew: pending.proposal.isNew,
			oldContent: pending.proposal.oldContent,
			newContent: pending.latest,
			snippetOnly: pending.proposal.snippetOnly,
			reason: "Re-requested after the hub restarted.",
		});
		pendingReviews.delete(oldId);
		pending.id = created.id;
		pendingReviews.set(created.id, pending);
		reviewByToolCall.set(pending.toolCallId, created.id);
		if (created.status === "approved") pending.resolve({ decision: "approved", content: pending.latest });
	}

	function startChannel(ctx: ExtensionContext) {
		latestCtx = ctx;
		if (channelStarted) return;
		channelStarted = true;
		void client.openChannel(register);
	}

	async function handleReviewAsk(message: ChannelMessage, revise: boolean) {
		const pending = pendingReviews.get(message.reviewId);
		if (!pending) {
			await client.post(`/api/reviews/${message.reviewId}/chat`, { role: "system", text: "This review is no longer active in the agent." }).catch(() => {});
			return;
		}
		if (revise && pending.proposal.snippetOnly) {
			await client.post(`/api/reviews/${message.reviewId}/chat`, { role: "system", text: "This preview only shows the edit snippets, so it can't be revised in place. Deny with your feedback and the agent will redo the change." }).catch(() => {});
			return;
		}
		const reviewContext = { path: pending.proposal.path, oldContent: pending.proposal.oldContent, newContent: pending.latest, chat: pending.chat };
		pending.chat.push({ role: "user", text: message.text });
		const signal = pending.abort.signal;
		try {
			if (revise) {
				const revision = await reviseProposal(pending.ctx, reviewContext, message.text, message.lineComments ?? [], signal);
				if (signal.aborted) return;
				pending.latest = revision.content;
				pending.chat.push({ role: "agent", text: revision.note });
				await client.post(`/api/reviews/${message.reviewId}/revision`, { content: revision.content, note: revision.note });
			} else {
				const answer = await answerReviewQuestion(pending.ctx, reviewContext, message.text, message.lineComments ?? [], signal);
				if (signal.aborted) return;
				pending.chat.push({ role: "agent", text: answer });
				await client.post(`/api/reviews/${message.reviewId}/chat`, { role: "agent", text: answer });
			}
		} catch (error: any) {
			if (signal.aborted) return;
			const text = revise
				? `Could not revise in place (${error.message}). Deny with your feedback instead and the agent will redo the change.`
				: `Could not answer (${error.message}).`;
			await client.post(`/api/reviews/${message.reviewId}/chat`, { role: "system", text }).catch(() => {});
		}
	}

	function isIdle(): boolean {
		try {
			return latestCtx?.isIdle() ?? true;
		} catch {
			return true;
		}
	}

	function deliver(text: string, deliverAs?: "steer" | "followUp") {
		if (isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: deliverAs ?? "steer" });
	}

	function deliverHubNote(text: string) {
		const idle = isIdle();
		pi.sendMessage({ customType: "pi-hub", content: text, display: true }, { triggerTurn: true, deliverAs: idle ? "steer" : "followUp" });
	}

	async function runSummary() {
		if (!latestCtx) return;
		try {
			const text = await summarizeSession(latestCtx);
			client.event({ kind: "summary", text });
		} catch (error: any) {
			client.event({ kind: "error", text: `summary failed: ${error.message}` });
		}
	}

	function handleChannel(message: ChannelMessage) {
		switch (message.type) {
			case "review_decision": {
				const pending = pendingReviews.get(message.reviewId);
				pending?.resolve({ decision: message.decision, comment: message.comment, lineComments: message.lineComments, content: message.content });
				break;
			}
			case "review_ask":
				void handleReviewAsk(message, false);
				break;
			case "review_revise":
				void handleReviewAsk(message, true);
				break;
			case "answer":
				pendingQuestions.get(message.questionId)?.resolve(message.text);
				break;
			case "user_message":
				deliver(message.text, message.deliverAs);
				break;
			case "agent_message":
				deliverHubNote(`[hub] Message from agent "${message.fromName}" (${message.from}):\n\n${message.body}\n\nReply with the hub_message tool if a response is needed.`);
				break;
			case "task_assigned":
				deliverHubNote(`[hub] You were assigned task ${message.task.id}: "${message.task.title}"\n\n${message.task.description ?? ""}\n\nUse hub_tasks to update its status as you work.`);
				break;
			case "task_unblocked":
				deliverHubNote(`[hub] Task ${message.task.id} "${message.task.title}" is unblocked: dependency "${message.unblockedBy.title}" is done.`);
				break;
			case "abort":
				latestCtx?.abort();
				break;
			case "summarize":
				void runSummary();
				break;
			case "trust":
				trust = message.mode;
				renderStatus();
				break;
			case "config":
				summaryConfig = message.config?.summaries ?? summaryConfig;
				break;
			case "rename":
				pi.setSessionName(message.name);
				break;
		}
	}

	function waitForDecision(reviewId: string, pending: Omit<PendingReview, "resolve" | "abort">, signal?: AbortSignal): Promise<ReviewDecision> {
		return new Promise((resolve) => {
			let settled = false;
			const entry: PendingReview = { ...pending, abort: new AbortController(), resolve: (decision) => finish(decision) };
			const finish = (decision: ReviewDecision) => {
				if (settled) return;
				settled = true;
				entry.abort.abort();
				pendingReviews.delete(entry.id);
				signal?.removeEventListener("abort", onAbort);
				renderStatus();
				resolve(decision);
			};
			const onAbort = () => {
				void client.post(`/api/reviews/${entry.id}/cancel`, { reason: "agent aborted" }).catch(() => {});
				finish({ decision: "cancelled" });
			};
			pendingReviews.set(reviewId, entry);
			renderStatus();
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async function terminalFallback(proposal: Proposal, ctx: ExtensionContext) {
		if (!ctx.hasUI) return undefined;
		const stats = diffStats(proposal.oldContent, proposal.newContent);
		const ok = await ctx.ui.confirm("pi hub offline — apply change?", `${proposal.tool} ${proposal.path} (+${stats.added} −${stats.removed})`);
		return ok ? undefined : { block: true, reason: `The user rejected the ${proposal.path} change in the terminal.` };
	}

	pi.on("session_start", async (_event, ctx) => {
		startChannel(ctx);
		if (client.connected) await register().catch(() => {});
	});

	pi.on("session_shutdown", async () => {
		latestCtx = undefined;
		const open = [...pendingReviews.values()];
		await Promise.all(open.map((pending) => client.post(`/api/reviews/${pending.id}/cancel`, { reason: "pi session ended" }).catch(() => {})));
		for (const pending of open) pending.resolve({ decision: "cancelled" });
		for (const [questionId, pending] of pendingQuestions) {
			void client.post(`/api/inbox/${questionId}/resolve`, { outcome: "pi session ended" }).catch(() => {});
			pending.resolve(undefined);
		}
		await client.close();
		channelStarted = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		latestCtx = ctx;
		lastPrompt = event.prompt ?? "";
	});

	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		runFiles = new Set();
		runTurns = 0;
		client.event({ kind: "agent_start", prompt: lastPrompt });
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		runTurns++;
		client.event({ kind: "turn_end" });
		const usage = ctx.getContextUsage();
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		void client.post(`/api/sessions/${encodeURIComponent(id)}/state`, { context: usage, model }).catch(() => {});
	});

	pi.on("message_end", async (event, ctx) => {
		latestCtx = ctx;
		const message: any = event.message;
		if (message?.role !== "assistant") return;
		const text = textOf(message.content);
		if (text.trim()) client.event({ kind: "assistant", text });
		const usage = message.usage;
		if (usage) {
			client.event({ kind: "usage", cost: usage.cost?.total ?? 0, input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 });
		}
	});

	pi.on("tool_execution_start", async (event) => {
		client.event({ kind: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId, summary: toolSummary(event.toolName, event.args) });
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.isError) client.event({ kind: "tool_end", toolName: event.toolName, isError: true, summary: textOf(event.result?.content).slice(0, 400) });
	});

	pi.on("agent_end", async (event, ctx) => {
		latestCtx = ctx;
		const cwd = ctx.cwd;
		const messages: any[] = (event as any).messages ?? [];
		const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
		const error = lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage ?? "error" : lastAssistant?.stopReason === "aborted" ? "aborted" : undefined;
		client.event({ kind: "agent_end", text: textOf(lastAssistant?.content), error, files: [...runFiles] });
		await client.flush();
		if (summaryConfig.onAgentEnd && runTurns >= (summaryConfig.minTurns ?? 3) && !error) void runSummary();
		const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		if (branch) void client.post(`/api/sessions/${encodeURIComponent(id)}/state`, { branch }).catch(() => {});
	});

	pi.on("tool_call", async (event, ctx) => {
		latestCtx = ctx;
		if (!gateEnabled || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const proposal = buildProposal(event.toolName, event.input, ctx.cwd);
		if (!proposal) return;
		if (proposal.oldContent === proposal.newContent && !proposal.isNew) return;
		if (!(await client.ready())) return terminalFallback(proposal, ctx);

		let created: { id: string; status: string; auto?: string };
		try {
			created = await client.post("/api/reviews", {
				sessionId: id,
				toolCallId: event.toolCallId,
				tool: proposal.tool,
				path: proposal.path,
				absPath: proposal.absPath,
				isNew: proposal.isNew,
				oldContent: proposal.oldContent,
				newContent: proposal.newContent,
				snippetOnly: proposal.snippetOnly,
				reason: proposal.snippetOnly ? "Preview shows only the edited snippets: the full result could not be computed ahead of time." : undefined,
			});
		} catch {
			return terminalFallback(proposal, ctx);
		}
		reviewByToolCall.set(event.toolCallId, created.id);
		runFiles.add(proposal.absPath);
		if (created.status === "approved") return;

		if (ctx.hasUI) ctx.ui.notify(`Waiting for review: ${proposal.path} (open the dashboard with /hub)`, "info");
		const decision = await waitForDecision(created.id, { id: created.id, toolCallId: event.toolCallId, proposal, chat: [], latest: proposal.newContent, ctx }, ctx.signal);

		if (decision.decision === "cancelled") return { block: true, reason: "The change was cancelled before review completed." };
		if (decision.decision === "denied") {
			runFiles.delete(proposal.absPath);
			return { block: true, reason: formatDenial(proposal.path, decision) };
		}
		if (proposal.snippetOnly) return undefined;
		const finalContent = decision.content ?? proposal.newContent;
		if (proposal.tool === "edit" && finalContent === proposal.editBase) {
			runFiles.delete(proposal.absPath);
			return { block: true, reason: `The reviewer approved ${proposal.path} with every hunk excluded, so the file was left unchanged. Do not retry this change.` };
		}
		if (finalContent !== proposal.newContent) rewriteInputForContent(proposal, event.input, finalContent);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		latestCtx = ctx;
		const reviewId = reviewByToolCall.get(event.toolCallId);
		if (reviewId) {
			reviewByToolCall.delete(event.toolCallId);
			void client.post(`/api/reviews/${reviewId}/applied`, { ok: !event.isError, error: event.isError ? textOf(event.content).slice(0, 500) : undefined }).catch(() => {});
		}
		if (event.toolName === "bash" && isTestCommand((event.input as any)?.command)) {
			const output = textOf(event.content);
			const commandExit = output.match(/Command exited with code (\d+)\s*$/i);
			const exitCode = commandExit ? Number(commandExit[1]) : event.isError ? 1 : 0;
			void client.post("/api/tests/ingest", { sessionId: id, cwd: ctx.cwd, command: (event.input as any).command, output, exitCode }).catch(() => {});
		}
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the human a question through the pi hub dashboard (and terminal) and wait for the answer. Use when you need a decision or missing information instead of guessing.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Optional suggested answers" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const terminalAbort = new AbortController();
			let questionId: string | undefined;
			const answers: Promise<{ text: string | undefined; via: string }>[] = [];
			if (await client.ready()) {
				try {
					const created = await client.post("/api/questions", { sessionId: id, question: params.question, options: params.options ?? [] });
					questionId = created.id;
					answers.push(new Promise((resolve) => pendingQuestions.set(created.id, { question: params.question, options: params.options ?? [], resolve: (text) => resolve({ text, via: "hub" }) })));
				} catch {}
			}
			if (ctx.hasUI) {
				const dialog = params.options?.length
					? ctx.ui.select(params.question, [...params.options, "(answer in hub)"], { signal: terminalAbort.signal })
					: ctx.ui.input(params.question, "type an answer, or answer in the hub", { signal: terminalAbort.signal });
				answers.push(dialog.then((text) => ({ text: text === "(answer in hub)" ? undefined : text, via: "terminal" })).then((r) => (r.text === undefined && questionId ? new Promise(() => {}) : r)) as any);
			}
			if (!answers.length) return { content: [{ type: "text", text: "No way to reach the user (hub offline, no UI)." }], details: {}, isError: true };
			const aborted = new Promise<{ text: undefined; via: string }>((resolve) => signal?.addEventListener("abort", () => resolve({ text: undefined, via: "abort" }), { once: true }));
			const result = await Promise.race([...answers, aborted]);
			terminalAbort.abort();
			if (questionId) {
				for (const [key, value] of pendingQuestions) if (value.question === params.question) pendingQuestions.delete(key);
				if (result.via !== "hub") void client.post(`/api/inbox/${questionId}/resolve`, { outcome: result.via === "terminal" ? "answered in terminal" : "cancelled", answer: result.text }).catch(() => {});
			}
			if (result.text === undefined) return { content: [{ type: "text", text: "The user did not answer." }], details: { via: result.via } };
			return { content: [{ type: "text", text: `User answered: ${result.text}` }], details: { via: result.via } };
		},
	});

	pi.registerTool({
		name: "report_progress",
		label: "Report progress",
		description:
			"Publish your plan as a checklist to the pi hub dashboard so the human can track progress. Call it when you form a plan and whenever a step changes status. Always send the full list of steps.",
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					title: Type.String(),
					status: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("done"), Type.Literal("blocked")]),
				}),
			),
			note: Type.Optional(Type.String({ description: "Short status note" })),
		}),
		async execute(_toolCallId, params) {
			client.event({ kind: "progress", steps: params.steps, note: params.note });
			const done = params.steps.filter((s) => s.status === "done").length;
			return { content: [{ type: "text", text: `Progress recorded (${done}/${params.steps.length}).` }], details: {} };
		},
	});

	pi.registerTool({
		name: "hub_agents",
		label: "List agents",
		description: "List the other coding agents currently connected to the pi hub (name, color, repo, branch, status, current task).",
		parameters: Type.Object({}),
		async execute() {
			const { agents } = await client.get("/api/agents");
			const others = agents.filter((a: any) => a.id !== id);
			const text = others.length
				? others.map((a: any) => `- ${a.name} [${a.color}] id=${a.id} ${a.repo ?? ""}@${a.branch ?? "?"} status=${a.status}${a.task ? ` task="${a.task}"` : ""}`).join("\n")
				: "No other agents are connected.";
			return { content: [{ type: "text", text }], details: { agents: others } };
		},
	});

	pi.registerTool({
		name: "hub_message",
		label: "Message agent",
		description:
			'Send a message to another agent (by id, name, or color) or to the human (to: "human") through the pi hub. Use it to coordinate shared work, hand off results, or ask the human for attention without blocking.',
		parameters: Type.Object({
			to: Type.String({ description: 'Agent id, name, color, or "human"' }),
			body: Type.String({ description: "Message text" }),
		}),
		async execute(_toolCallId, params) {
			const result = await client.post("/api/messages", { from: id, to: params.to, body: params.body });
			const target = result.to === "human" ? "the human" : result.toName;
			return { content: [{ type: "text", text: result.delivered ? `Delivered to ${target}.` : `Queued for ${target} (agent offline).` }], details: result };
		},
	});

	pi.registerTool({
		name: "hub_tasks",
		label: "Hub tasks",
		description:
			"Shared task board for coordinating agents. action=list shows tasks; create adds one (title, description, deps); claim assigns a task to you and marks it doing; update changes status (todo|doing|review|done|blocked) and can add a note.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("claim"), Type.Literal("update")]),
			id: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("review"), Type.Literal("done"), Type.Literal("blocked")])),
			deps: Type.Optional(Type.Array(Type.String())),
			note: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params): Promise<any> {
			if (params.action === "list") {
				const { tasks } = await client.get("/api/tasks");
				const text = tasks.length
					? tasks.map((t: any) => `- ${t.id} [${t.status}] ${t.title}${t.owner ? ` owner=${t.owner}${t.owner === id ? " (you)" : ""}` : ""}${t.deps?.length ? ` deps=${t.deps.join(",")}` : ""}`).join("\n")
					: "No tasks.";
				return { content: [{ type: "text", text }], details: { tasks } };
			}
			if (params.action === "create") {
				if (!params.title) throw new Error("title is required");
				const { task } = await client.post("/api/tasks", { title: params.title, description: params.description, deps: params.deps ?? [], createdBy: id });
				return { content: [{ type: "text", text: `Created ${task.id}.` }], details: { task } };
			}
			if (!params.id) throw new Error("id is required");
			const fields: Record<string, unknown> = params.action === "claim" ? { owner: id, status: "doing" } : {};
			if (params.status) fields.status = params.status;
			if (params.note) Object.assign(fields, { note: params.note, by: id });
			if (params.deps) fields.deps = params.deps;
			const { task } = await client.request("PATCH", `/api/tasks/${encodeURIComponent(params.id)}`, fields);
			return { content: [{ type: "text", text: `${task.id} is now ${task.status}.` }], details: { task } };
		},
	});

	pi.registerCommand("hub", {
		description: "Open the pi hub dashboard in the browser",
		handler: async (args, ctx) => {
			if (!(await client.ready())) return ctx.ui.notify("pi hub is not reachable", "error");
			await client.post("/api/open-dashboard", { path: args.trim() ? `#/${args.trim()}` : "" });
		},
	});

	pi.registerCommand("hub-gate", {
		description: "Toggle the diff review gate: /hub-gate on|off",
		handler: async (args, ctx) => {
			gateEnabled = args.trim() === "" ? !gateEnabled : args.trim() !== "off";
			renderStatus();
			ctx.ui.notify(`Review gate ${gateEnabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("hub-trust", {
		description: "Auto-approve changes for this session: /hub-trust auto|review",
		handler: async (args, ctx) => {
			const mode = args.trim() === "auto" ? "auto" : "review";
			await client.post(`/api/sessions/${encodeURIComponent(id)}/trust`, { mode });
			trust = mode;
			renderStatus();
			ctx.ui.notify(`Hub trust: ${mode}`, "info");
		},
	});
}
