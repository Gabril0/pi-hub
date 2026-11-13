import { execFile } from "node:child_process";
import { hasCommand } from "./notify.mjs";

const FIELDS = "number,title,url,state,isDraft,reviewDecision,mergeable,headRefName,baseRefName,statusCheckRollup,mergedAt,updatedAt";

function gh(args, cwd) {
	return new Promise((resolve) => {
		execFile("gh", args, { cwd, timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			if (error) return resolve(undefined);
			try {
				resolve(JSON.parse(stdout));
			} catch {
				resolve(undefined);
			}
		});
	});
}

export function summarizeChecks(rollup = []) {
	const checks = rollup.map((check) => {
		const conclusion = String(check.conclusion ?? check.state ?? "").toUpperCase();
		const status = String(check.status ?? "").toUpperCase();
		let state = "pending";
		if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) state = "passed";
		else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) state = "failed";
		else if (status === "COMPLETED" && !conclusion) state = "passed";
		return { name: check.name ?? check.context ?? "check", state, url: check.detailsUrl ?? check.targetUrl };
	});
	const failed = checks.filter((c) => c.state === "failed").length;
	const pending = checks.filter((c) => c.state === "pending").length;
	const overall = !checks.length ? "none" : failed ? "failed" : pending ? "pending" : "passed";
	return { checks, overall };
}

const PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const PR_SHORT = /(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)\b/g;

export function isPrRef(ref) {
	return Boolean(ref) && typeof ref.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(ref.repo) && Number.isInteger(ref.number) && ref.number > 0;
}

export function prKey(ref) {
	return `${ref.repo.toLowerCase()}#${ref.number}`;
}

export function parsePrRefs(text, { short = false } = {}) {
	const found = new Map();
	const value = String(text ?? "");
	const patterns = short ? [PR_URL, PR_SHORT] : [PR_URL];
	for (const pattern of patterns) {
		for (const match of value.matchAll(pattern)) {
			const ref = { repo: match[1], number: Number(match[2]) };
			if (isPrRef(ref) && !found.has(prKey(ref))) found.set(prKey(ref), ref);
		}
	}
	return [...found.values()];
}

export function toPr(pr, repo) {
	const { checks, overall } = summarizeChecks(pr.statusCheckRollup);
	return {
		id: `pr_${repo}#${pr.number}`.replace(/[^\w#/.-]/g, "_"),
		repo,
		number: pr.number,
		title: pr.title,
		url: pr.url,
		state: pr.state,
		isDraft: pr.isDraft,
		reviewDecision: pr.reviewDecision || "NONE",
		mergeable: pr.mergeable,
		head: pr.headRefName,
		base: pr.baseRefName,
		mergedAt: pr.mergedAt,
		ghUpdatedAt: pr.updatedAt,
		checks,
		checksState: overall,
	};
}

export async function fetchPrForCwd(cwd) {
	const pr = await gh(["pr", "view", "--json", FIELDS], cwd);
	if (!pr?.number) return undefined;
	const repo = await gh(["repo", "view", "--json", "nameWithOwner"], cwd);
	return toPr(pr, repo?.nameWithOwner ?? cwd);
}

export async function fetchPr(ref) {
	if (!isPrRef(ref)) return undefined;
	const pr = await gh(["pr", "view", String(ref.number), "--repo", ref.repo, "--json", FIELDS]);
	if (!pr?.number) return undefined;
	return toPr(pr, ref.repo);
}

export function prTransitions(previous, next) {
	if (!previous) return [];
	const out = [];
	if (previous.checksState !== next.checksState && ["failed", "passed"].includes(next.checksState)) out.push(`checks ${next.checksState}`);
	if (previous.reviewDecision !== next.reviewDecision && next.reviewDecision !== "NONE") out.push(`review ${next.reviewDecision.toLowerCase().replace(/_/g, " ")}`);
	if (previous.state !== next.state) out.push(next.state.toLowerCase());
	return out;
}

export function ghAvailable() {
	return hasCommand("gh");
}
