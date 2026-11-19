import { canonicalPath } from "../hub/paths.mjs";

export interface KnowledgeBrief {
	text: string;
	notes: Array<{ where: string; text: string; by?: string }>;
}

export type BriefRequest = (url: string, signal: AbortSignal) => Promise<Partial<KnowledgeBrief>>;

export interface BriefOptions {
	timeoutMs?: number;
	retryDelayMs?: number;
}

async function attempt(request: BriefRequest, url: string, timeoutMs: number): Promise<Partial<KnowledgeBrief>> {
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`timed out after ${timeoutMs}ms`));
			controller.abort();
		}, timeoutMs);
	});
	try {
		return await Promise.race([request(url, controller.signal), expired]);
	} finally {
		clearTimeout(timer);
	}
}

export async function loadKnowledgeBrief(request: BriefRequest, path: string, report: (text: string) => void, { timeoutMs = 5000, retryDelayMs = 200 }: BriefOptions = {}): Promise<KnowledgeBrief> {
	const url = `/api/knowledge/brief?path=${encodeURIComponent(canonicalPath(path))}`;
	try {
		const brief = await attempt(request, url, timeoutMs).catch(async () => {
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
			return attempt(request, url, timeoutMs);
		});
		return { text: brief.text ?? "", notes: brief.notes ?? [] };
	} catch (error: any) {
		report(`knowledge brief failed: ${error.message}`);
		return { text: "", notes: [] };
	}
}
