import { complete, type Message } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { unifiedDiff } from "./edits";

const MAX_FILE_CHARS = 120_000;

export interface LineComment {
	side: "old" | "new";
	line: number;
	text: string;
	snippet?: string;
}

export interface ReviewContext {
	path: string;
	oldContent: string;
	newContent: string;
	chat: Array<{ role: string; text: string }>;
}

export function formatLineComments(comments: LineComment[] = []): string {
	if (!comments.length) return "";
	return comments.map((c) => `- ${c.side === "old" ? "original" : "proposed"} line ${c.line}${c.snippet ? ` (\`${c.snippet.trim().slice(0, 120)}\`)` : ""}: ${c.text}`).join("\n");
}

function recentConversation(ctx: ExtensionContext, maxChars = 24_000): string {
	try {
		const messages = ctx.sessionManager
			.getBranch()
			.filter((entry: any) => entry.type === "message")
			.map((entry: any) => entry.message)
			.slice(-12);
		const text = serializeConversation(convertToLlm(messages));
		return text.length > maxChars ? text.slice(-maxChars) : text;
	} catch {
		return "";
	}
}

async function ask(ctx: ExtensionContext, systemPrompt: string, prompt: string, signal?: AbortSignal): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("no model selected");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const userMessage: Message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
	const response = await complete(model, { systemPrompt, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal });
	if (response.stopReason === "error") throw new Error(response.errorMessage ?? "model error");
	return response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

function reviewMaterial(review: ReviewContext): string {
	const diff = unifiedDiff(review.oldContent, review.newContent, review.path, 4);
	const includeFile = review.newContent.length <= MAX_FILE_CHARS;
	const chat = review.chat
		.slice(-10)
		.map((m) => `${m.role}: ${m.text}`)
		.join("\n\n");
	return [
		`File: ${review.path}`,
		"",
		"Proposed diff:",
		"```diff",
		diff,
		"```",
		includeFile ? `\nFull proposed file:\n\`\`\`\n${review.newContent}\n\`\`\`` : "",
		chat ? `\nReview conversation so far:\n${chat}` : "",
	].join("\n");
}

export async function answerReviewQuestion(ctx: ExtensionContext, review: ReviewContext, question: string, comments: LineComment[], signal?: AbortSignal): Promise<string> {
	const system =
		"You are the coding agent that proposed a file change. The user is reviewing it in a diff viewer before it is applied and is asking you about it. " +
		"Answer directly and concisely in GitHub-flavored markdown. Explain the reasoning behind the change, reference specific lines, and flag real risks. " +
		"Do not propose a rewritten file; the user has a separate button to request changes.";
	const prompt = [
		"Conversation leading to this change:",
		recentConversation(ctx),
		"",
		reviewMaterial(review),
		"",
		comments.length ? `Line comments from the reviewer:\n${formatLineComments(comments)}\n` : "",
		`Reviewer question: ${question}`,
	].join("\n");
	return ask(ctx, system, prompt, signal);
}

export function extractRevision(output: string): { note: string; content: string } | undefined {
	const noteMatch = output.match(/^NOTE:\s*(.+)$/m);
	const fence = output.match(/(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/m) ?? output.match(/(`{3,}|~{3,})[^\n]*\n([\s\S]*)\n\1/);
	if (!fence) return undefined;
	return { note: noteMatch?.[1]?.trim() ?? "Revised per review feedback", content: fence[2] };
}

export async function reviseProposal(ctx: ExtensionContext, review: ReviewContext, instruction: string, comments: LineComment[], signal?: AbortSignal): Promise<{ note: string; content: string }> {
	const system =
		"You are the coding agent that proposed a file change. The reviewer requested changes to your proposal before it is applied. " +
		"Produce the complete revised file. Output format, exactly:\n" +
		"NOTE: <one sentence describing what you changed>\n" +
		"````\n<the entire revised file content>\n````\n" +
		"Use a four-backtick fence. Output nothing after the closing fence. Keep everything the reviewer did not ask to change identical to the proposed file. " +
		"The original file (before your proposal) is the baseline; the reviewer may ask you to keep parts of it.";
	const prompt = [
		"Conversation leading to this change:",
		recentConversation(ctx, 12_000),
		"",
		`Original file before the proposal:\n\`\`\`\`\n${review.oldContent.length <= MAX_FILE_CHARS ? review.oldContent : "(too large to include)"}\n\`\`\`\``,
		"",
		reviewMaterial(review),
		"",
		comments.length ? `Line comments from the reviewer:\n${formatLineComments(comments)}\n` : "",
		`Requested changes: ${instruction || "Address the line comments."}`,
	].join("\n");
	const output = await ask(ctx, system, prompt, signal);
	const revision = extractRevision(output);
	if (!revision) throw new Error("model did not return a fenced file");
	if (review.newContent.endsWith("\n") && !revision.content.endsWith("\n")) revision.content += "\n";
	return revision;
}

export async function summarizeSession(ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	const system =
		"Summarize what this coding agent has been doing for a busy engineer glancing at a dashboard. " +
		"Write at most 4 short bullet points: goal, what is done, what is in progress, and any blocker or decision needed. No preamble.";
	return ask(ctx, system, recentConversation(ctx, 30_000) || "(no conversation yet)", signal);
}
