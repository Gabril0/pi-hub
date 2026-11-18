import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const MAX_STAGED = 2;

export interface StagedDecision {
	decision: "approved" | "denied" | "cancelled";
	comment?: string;
	lineComments?: any[];
	content?: string;
}

export interface StagedEntry {
	id: string;
	toolCallId: string;
	tool: "edit" | "write";
	path: string;
	absPath: string;
	isNew: boolean;
	rawBase: string | null;
	rawAfter: string;
	before: string;
	after: string;
	held: boolean;
	assumedHead?: string;
	decision?: StagedDecision;
	ready: Promise<void>;
	ctx: ExtensionContext;
}

export type Reconcile = { kind: "unaffected" } | { kind: "revised"; note: string; content: string } | { kind: "redo"; reason: string };

export interface ReconcileRequest {
	ctx: ExtensionContext;
	changedPath: string;
	previous: string;
	current: string;
	why: string;
	nextPath: string;
	nextBefore: string;
	nextAfter: string;
	conflict: boolean;
}

export interface StageRequest {
	toolCallId: string;
	tool: "edit" | "write";
	path: string;
	absPath: string;
	content: string;
	readBase?: string;
	ctx: ExtensionContext;
	signal?: AbortSignal;
}

export interface QueueDeps {
	create(entry: StagedEntry): Promise<{ id: string; status: string }>;
	wait(entry: StagedEntry): Promise<StagedDecision>;
	promote(id: string): Promise<unknown>;
	revise(id: string, change: { content: string; oldContent: string; note: string }): Promise<unknown>;
	cancel(entry: StagedEntry, reason: string): Promise<unknown>;
	applied(id: string, ok: boolean, error?: string): Promise<unknown>;
	reconcile(request: ReconcileRequest): Promise<Reconcile>;
	readDisk(absPath: string): string | null;
	writeDisk(absPath: string, raw: string): void;
	display(tool: "edit" | "write", raw: string): string;
	restore(content: string, rawBase: string | null): string;
	rebase(before: string, after: string, base: string): string | undefined;
	denialNote(path: string, decision: StagedDecision): string;
	approvalNote(path: string, decision: StagedDecision, modified: boolean): string | undefined;
	onApplied?(absPath: string): void;
}

function abortError() {
	return new Error("Operation aborted");
}

export class StagedQueue {
	private entries: StagedEntry[] = [];
	private waiters = new Set<() => void>();
	private work: Promise<void> = Promise.resolve();
	private checking: Promise<void> = Promise.resolve();
	private notes: string[] = [];
	private readonly deps: QueueDeps;

	constructor(deps: QueueDeps) {
		this.deps = deps;
	}

	get size() {
		return this.entries.length;
	}

	get paths() {
		return [...new Set(this.entries.map((entry) => entry.path))];
	}

	has(absPath: string) {
		return this.entries.some((entry) => entry.absPath === absPath);
	}

	read(absPath: string): string | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].absPath === absPath) return this.entries[i].rawAfter;
		return undefined;
	}

	isHeld(id: string) {
		return this.entries.some((entry) => entry.id === id && entry.held);
	}

	rename(oldId: string, newId: string) {
		const entry = this.entries.find((item) => item.id === oldId);
		if (entry) entry.id = newId;
	}

	takeNotes(): string[] {
		return this.notes.splice(0);
	}

	private changed() {
		for (const wake of [...this.waiters]) wake();
	}

	private until(ready: () => boolean, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = (action: () => void) => {
				this.waiters.delete(check);
				signal?.removeEventListener("abort", onAbort);
				action();
			};
			const check = () => {
				if (ready()) finish(resolve);
			};
			const onAbort = () => finish(() => reject(abortError()));
			if (signal?.aborted) return reject(abortError());
			this.waiters.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	drained(signal?: AbortSignal) {
		return this.until(() => this.entries.length === 0, signal);
	}

	async stage(request: StageRequest): Promise<boolean> {
		const { deps } = this;
		await this.until(() => this.entries.length < MAX_STAGED, request.signal);
		const overlay = this.read(request.absPath);
		const current = overlay ?? deps.readDisk(request.absPath);
		let raw = request.content;
		if (request.tool === "edit" && request.readBase !== undefined && current !== request.readBase) {
			const rebased = deps.rebase(deps.display("edit", request.readBase), deps.display("edit", raw), deps.display("edit", current ?? ""));
			if (rebased === undefined) throw new Error(`${request.path} changed during review, so this edit no longer applies. Read the file again and redo it.`);
			raw = deps.restore(rebased, current);
		}
		const before = deps.display(request.tool, current ?? "");
		const after = deps.display(request.tool, raw);
		if (current !== null && before === after) return false;
		const head = this.entries[0];
		let markReady = () => {};
		const entry: StagedEntry = {
			id: "",
			toolCallId: request.toolCallId,
			tool: request.tool,
			path: request.path,
			absPath: request.absPath,
			isNew: current === null,
			rawBase: current,
			rawAfter: raw,
			before,
			after,
			held: Boolean(head),
			assumedHead: head?.after,
			ready: new Promise((resolve) => (markReady = resolve)),
			ctx: request.ctx,
		};
		this.entries.push(entry);
		this.changed();
		try {
			const created = await deps.create(entry);
			entry.id = created.id;
			if (created.status === "approved") entry.decision = { decision: "approved" };
			else {
				void deps.wait(entry).then((decision) => {
					entry.decision = decision;
					this.pump();
				});
			}
		} catch (error) {
			this.entries = this.entries.filter((item) => item !== entry);
			this.changed();
			throw error;
		} finally {
			markReady();
		}
		this.pump();
		return true;
	}

	headChanged(id: string, content: string, why: string, note?: string) {
		const head = this.entries[0];
		if (!head || head.id !== id) return;
		head.after = content;
		head.rawAfter = this.deps.restore(content, head.rawBase);
		this.notes.push(`The reviewer had your staged change to ${head.path} revised${note ? `: ${note}` : ""}. Read the file again before relying on its old content.`);
		this.recheck(head, content, head.rawAfter, why);
	}

	private recheck(head: StagedEntry, final: string, finalRaw: string | null, why: string) {
		this.checking = this.checking.then(() => this.syncNext(head, final, finalRaw, why)).catch(() => {});
		return this.checking;
	}

	private async syncNext(head: StagedEntry, final: string, finalRaw: string | null, why: string) {
		const { deps } = this;
		const next = this.entries[this.entries.indexOf(head) + 1];
		if (!next) return;
		await next.ready;
		if (next.assumedHead === final) return;
		const samePath = next.absPath === head.absPath;
		const nextBefore = samePath ? deps.display(next.tool, finalRaw ?? "") : next.before;
		const rebased = samePath ? deps.rebase(next.before, next.after, nextBefore) : next.after;
		const conflict = rebased === undefined;
		let verdict: Reconcile;
		try {
			verdict = await deps.reconcile({ ctx: next.ctx, changedPath: head.path, previous: next.assumedHead ?? "", current: final, why, nextPath: next.path, nextBefore, nextAfter: rebased ?? next.after, conflict });
		} catch (error: any) {
			verdict = conflict ? { kind: "redo", reason: `it could not be re-checked (${error.message})` } : { kind: "unaffected" };
		}
		if (!this.entries.includes(next)) return;
		if (verdict.kind === "redo" || (conflict && verdict.kind === "unaffected")) {
			const reason = verdict.kind === "redo" ? verdict.reason : "it no longer fits the reviewed change";
			await this.discard(next, reason);
			return;
		}
		const nextAfter = verdict.kind === "revised" ? verdict.content : (rebased as string);
		const rawBase = samePath ? finalRaw : next.rawBase;
		const contentChanged = nextAfter !== next.after || nextBefore !== next.before;
		next.before = nextBefore;
		next.after = nextAfter;
		next.rawBase = rawBase;
		next.rawAfter = deps.restore(nextAfter, rawBase);
		next.assumedHead = final;
		if (!contentChanged) return;
		const note = verdict.kind === "revised" ? verdict.note : `Updated to sit on top of the reviewed ${head.path}.`;
		await deps.revise(next.id, { content: nextAfter, oldContent: nextBefore, note });
		this.notes.push(`Your staged change to ${next.path} was updated after the review: ${note} Read the file again before relying on its old content.`);
	}

	private async discard(entry: StagedEntry, reason: string) {
		this.entries = this.entries.filter((item) => item !== entry);
		this.notes.push(`Your staged change to ${entry.path} was discarded because ${reason}. It was NOT applied. Read the file again and redo it if it is still needed.`);
		this.changed();
		await entry.ready;
		await this.deps.cancel(entry, reason).catch(() => {});
	}

	private pump() {
		this.work = this.work.then(() => this.settle()).catch(() => {});
	}

	private async settle() {
		for (let head = this.entries[0]; head?.decision; head = this.entries[0]) {
			await head.ready;
			await this.checking;
			const { final, finalRaw, why, cancelled } = await this.conclude(head, head.decision);
			if (cancelled) {
				for (const entry of this.entries.slice(1)) await this.discard(entry, "the change before it was cancelled");
			} else await this.recheck(head, final, finalRaw, why);
			this.entries = this.entries.filter((item) => item !== head);
			const next = this.entries[0];
			if (next) {
				await next.ready;
				if (next.held) {
					next.held = false;
					if (!next.decision) await this.deps.promote(next.id).catch(() => {});
				}
			}
			this.changed();
		}
	}

	private async conclude(head: StagedEntry, decision: StagedDecision) {
		const { deps } = this;
		const unchanged = { final: head.before, finalRaw: head.rawBase };
		if (decision.decision === "cancelled") return { ...unchanged, why: "it was cancelled", cancelled: true };
		if (decision.decision === "denied") {
			this.notes.push(deps.denialNote(head.path, decision));
			return { ...unchanged, why: `the reviewer denied it${decision.comment ? `: ${decision.comment}` : ""}`, cancelled: false };
		}
		const disk = deps.readDisk(head.absPath);
		if (disk !== head.rawBase) {
			const error = "The file changed on disk while this review was open, so nothing was written.";
			await deps.applied(head.id, false, error).catch(() => {});
			this.notes.push(`${head.path} changed on disk while your change was waiting for review (the user or another agent edited it), so nothing was written. Read the file again and redo the change against its current content.`);
			return { final: deps.display(head.tool, disk ?? ""), finalRaw: disk, why: "the file changed on disk", cancelled: false };
		}
		const final = decision.content ?? head.after;
		const modified = final !== head.after;
		const raw = modified ? deps.restore(final, head.rawBase) : head.rawAfter;
		try {
			deps.writeDisk(head.absPath, raw);
		} catch (error: any) {
			await deps.applied(head.id, false, error.message).catch(() => {});
			this.notes.push(`Your approved change to ${head.path} could not be written: ${error.message}`);
			return { ...unchanged, why: "it could not be written", cancelled: false };
		}
		deps.onApplied?.(head.absPath);
		await deps.applied(head.id, true).catch(() => {});
		const note = deps.approvalNote(head.path, decision, modified);
		if (note) this.notes.push(note);
		return { final, finalRaw: raw, why: modified ? "the reviewer approved it with modifications" : "it was approved", cancelled: false };
	}
}
