const LINE_PREFIX = /^\s*\d+ \|(?: |$)/;

export function numberLines(text: string): string {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const width = String(lines.length).length;
	return lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join("\n");
}

export function stripLineNumbers(content: string): string {
	const lines = content.split("\n");
	const filled = lines.filter((line) => line !== "");
	if (!filled.length || !filled.every((line) => LINE_PREFIX.test(line))) return content;
	return lines.map((line) => line.replace(LINE_PREFIX, "")).join("\n");
}

export type ChatReply = { kind: "answer"; text: string } | { kind: "revision"; note: string; content: string };

export const REVISION_FORMAT =
	"NOTE: <one sentence describing what you changed>\n" +
	"````\n<the entire revised file content, without line-number prefixes>\n````\n" +
	"Use a four-backtick fence and output nothing after the closing fence.";

export function parseChatReply(output: string, previous: string): ChatReply {
	if (/^\s*NOTE:/.test(output)) {
		const revision = extractRevision(output);
		if (revision) return { kind: "revision", ...finishRevision(revision, previous) };
	}
	return { kind: "answer", text: output };
}

export function extractRevision(output: string): { note: string; content: string } | undefined {
	const noteMatch = output.match(/^NOTE:\s*(.+)$/m);
	const fence = output.match(/(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/m) ?? output.match(/(`{3,}|~{3,})[^\n]*\n([\s\S]*)\n\1/);
	if (!fence) return undefined;
	return { note: noteMatch?.[1]?.trim() ?? "Revised per review feedback", content: fence[2] };
}

export function finishRevision(revision: { note: string; content: string }, previous: string): { note: string; content: string } {
	let content = stripLineNumbers(revision.content);
	if (previous.endsWith("\n") && !content.endsWith("\n")) content += "\n";
	return { note: revision.note, content };
}
