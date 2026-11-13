import { complete, type Message } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { finishRevision, extractRevision, numberLines, parseChatReply, REVISION_FORMAT, type ChatReply } from "./chat-reply";
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
		includeFile
			? `\nFull proposed file, numbered like the right side of the reviewer's diff view (the "N | " prefixes are not part of the file):\n\`\`\`\n${numberLines(review.newContent)}\n\`\`\``
			: "",
		chat ? `\nReview conversation so far:\n${chat}` : "",
	].join("\n");
}

export async function converseAboutProposal(ctx: ExtensionContext, review: ReviewContext, message: string, comments: LineComment[], signal?: AbortSignal): Promise<ChatReply> {
	const system =
		"You are the coding agent that proposed a file change. The user is looking at it in a diff reviewer chat before it is applied. Decide what they want.\n" +
		"- If they ask a question, answer directly and concisely in GitHub-flavored markdown, reference specific lines and flag real risks. Do not output a file.\n" +
		'- If they tell you to change the proposal (for example "change line 32 to use a match", "rename foo", "drop the logging"), rewrite the proposal. ' +
		`Output format, exactly:\n${REVISION_FORMAT}\n` +
		"Line numbers the reviewer mentions refer to the numbered proposed file unless they say original. Change only what they asked and keep everything else identical. " +
		"The reviewer still approves or denies afterwards; you are only editing the version under review.";
	const prompt = [
		"Conversation leading to this change:",
		recentConversation(ctx, 12_000),
		"",
		`Original file before the proposal:\n\`\`\`\`\n${review.oldContent.length <= MAX_FILE_CHARS ? review.oldContent : "(too large to include)"}\n\`\`\`\``,
		"",
		reviewMaterial(review),
		"",
		comments.length ? `Line comments from the reviewer:\n${formatLineComments(comments)}\n` : "",
		`Reviewer: ${message || "Address my line comments."}`,
	].join("\n");
	return parseChatReply(await ask(ctx, system, prompt, signal), review.newContent);
}

export async function reviseProposal(ctx: ExtensionContext, review: ReviewContext, instruction: string, comments: LineComment[], signal?: AbortSignal): Promise<{ note: string; content: string }> {
	const system =
		"You are the coding agent that proposed a file change. The reviewer requested changes to your proposal before it is applied. " +
		`Produce the complete revised file. Output format, exactly:\n${REVISION_FORMAT}\n` +
		"Keep everything the reviewer did not ask to change identical to the proposed file. Line numbers the reviewer mentions refer to the numbered proposed file. " +
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
	return finishRevision(revision, review.newContent);
}

export async function summarizeSession(ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	const system =
		"Summarize what this coding agent has been doing for a busy engineer glancing at a dashboard. " +
		"Write at most 4 short bullet points: goal, what is done, what is in progress, and any blocker or decision needed. No preamble.";
	return ask(ctx, system, recentConversation(ctx, 30_000) || "(no conversation yet)", signal);
}
