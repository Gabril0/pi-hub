import { html, useEffect, useMemo, useState } from "../vendor/preact-htm.js";
import { contentWithBlocks, diffOps, stats } from "../lib/diff.js";
import { api, openChangesets, sessionOf, toast, useStore } from "../lib/store.js";
import { Empty, SessionChip, colorOf, isTyping, navigate, timeAgo } from "../lib/util.js";
import { ChangesetKind, ChangesetStatus, DiffStat, DiffViewer, loadPrefs, savePrefs } from "./review.js";

const FILE_STATUS = { added: "A", modified: "M", deleted: "D" };
const REVERT_LABELS = { on: "keep", off: "reverted — restores original", title: "Keep this hunk, or revert it to the original" };

function useFullChangeset(id, status) {
	const [changeset, setChangeset] = useState(null);
	const [error, setError] = useState(null);
	useEffect(() => {
		let alive = true;
		api("GET", `/api/changesets/${encodeURIComponent(id)}`)
			.then(({ changeset }) => alive && setChangeset(changeset))
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, [id, status]);
	return { changeset, error };
}

function isText(file) {
	return !file.binary && !file.tooLarge;
}

function baseName(path) {
	const normalized = String(path ?? "").replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function dirName(path) {
	const normalized = String(path ?? "").replace(/\\/g, "/");
	const index = normalized.lastIndexOf("/");
	return index === -1 ? "" : normalized.slice(0, index + 1);
}

function revertedBlocks(file, model, whole, hunks) {
	if (!model) return new Set();
	if (whole.has(file.path)) return new Set(Array.from({ length: model.blocks }, (_, i) => i));
	return hunks.get(file.path) ?? new Set();
}

function revertContent(file, model, rejected) {
	if (!rejected.size || !model) return undefined;
	if (rejected.size >= model.blocks) return file.before ?? null;
	return contentWithBlocks(model.ops, rejected);
}

function outcomeTone(result) {
	if (result.endsWith("reverted")) return "ok";
	if (result.startsWith("failed")) return "bad";
	return "warn";
}

function FileRow({ file, model, rejected, selected, decided, outcome, onSelect }) {
	const fileStats = model ? stats(model.ops) : null;
	const reverting = rejected.size > 0;
	const whole = model && rejected.size >= model.blocks && model.blocks > 0;
	return html`<button class=${`cs-file ${selected ? "on" : ""}`} onClick=${onSelect} title=${file.path}>
		<span class=${`cs-file-status ${file.status}`}>${FILE_STATUS[file.status] ?? "?"}</span>
		<span class="cs-file-name">
			<span class="cs-file-base">${baseName(file.path)}</span>
			${dirName(file.path) ? html`<span class="cs-file-dir">${dirName(file.path).slice(0, -1)}</span>` : null}
		</span>
		${!isText(file) ? html`<span class="pill">${file.binary ? "binary" : "large"}</span>` : null}
		${!decided && reverting ? html`<span class="pill warn">${whole ? "revert" : `${rejected.size}/${model.blocks}`}</span>` : null}
		${outcome ? html`<span class=${`cs-outcome-dot ${outcomeTone(outcome.result)}`} title=${outcome.result}></span>` : null}
		${fileStats ? html`<span class="line-stats"><span class="plus">+${fileStats.added}</span><span class="minus">−${fileStats.removed}</span></span>` : null}
	</button>`;
}

export function ChangesetView({ id }) {
	const state = useStore();
	const summary = state.changesets.get(id);
	const { changeset, error } = useFullChangeset(id, summary?.status);
	const [selected, setSelected] = useState(0);
	const [hunks, setHunks] = useState(() => new Map());
	const [whole, setWhole] = useState(() => new Set());
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(null);
	const [prefs, setPrefsState] = useState(loadPrefs);

	const setPrefs = (patch) => {
		const next = { ...prefs, ...patch };
		setPrefsState(next);
		savePrefs(next);
	};

	const files = changeset?.files ?? [];
	const models = useMemo(() => new Map(files.filter(isText).map((f) => [f.path, diffOps(f.before ?? "", f.after ?? "")])), [changeset]);
	const status = summary?.status ?? changeset?.status;
	const actionable = status === "open" && !result;
	const index = Math.min(selected, Math.max(0, files.length - 1));
	const file = files[index];
	const model = file ? models.get(file.path) : null;
	const rejected = file ? revertedBlocks(file, model, whole, hunks) : new Set();
	const outcomes = result?.outcomes ?? summary?.outcomes ?? changeset?.outcomes ?? [];
	const outcomeOf = (path) => outcomes.find((o) => o.path === path);

	const plan = files
		.filter(isText)
		.map((f) => ({ path: f.path, content: revertContent(f, models.get(f.path), revertedBlocks(f, models.get(f.path), whole, hunks)) }))
		.filter((change) => change.content !== undefined);

	const toggleBlock = (block) => {
		if (!file || !model) return;
		const current = revertedBlocks(file, model, whole, hunks);
		const next = new Set(current);
		next.has(block) ? next.delete(block) : next.add(block);
		const nextWhole = new Set(whole);
		nextWhole.delete(file.path);
		setWhole(nextWhole);
		setHunks(new Map(hunks).set(file.path, next));
	};

	const toggleWhole = () => {
		if (!file || !model) return;
		const nextWhole = new Set(whole);
		const nextHunks = new Map(hunks);
		if (rejected.size >= model.blocks) {
			nextWhole.delete(file.path);
			nextHunks.delete(file.path);
		} else nextWhole.add(file.path);
		setWhole(nextWhole);
		setHunks(nextHunks);
	};

	const resolve = async (keepAll) => {
		if (!actionable || busy) return;
		setBusy(true);
		try {
			const res = await api("POST", `/api/changesets/${encodeURIComponent(id)}/resolve`, { files: keepAll ? [] : plan, comment: comment.trim() || undefined });
			setResult(res);
			const reverted = res.outcomes.filter((o) => o.result.endsWith("reverted")).length;
			toast({
				kind: "changeset",
				sessionId: changeset.sessionId,
				tone: res.outcomes.some((o) => !o.result.endsWith("reverted")) ? "warn" : "ok",
				title: keepAll ? "Kept all changes" : `Reverted ${reverted} of ${plan.length} file${plan.length === 1 ? "" : "s"}`,
				body: res.delivered ? "agent notified" : keepAll && !comment.trim() ? "nothing to tell the agent" : "agent offline, not delivered",
			});
		} catch (e) {
			toast({ kind: "error", sessionId: changeset?.sessionId, tone: "bad", title: "Could not resolve changes", body: e.message });
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		const onKey = (e) => {
			if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || !files.length) return;
			const key = e.key.toLowerCase();
			if (key === "j") setSelected((i) => Math.min(i + 1, files.length - 1));
			else if (key === "k") setSelected((i) => Math.max(i - 1, 0));
			else if (key === "r" && actionable && file && isText(file)) toggleWhole();
			else if (key === "s") setPrefs({ mode: prefs.mode === "split" ? "unified" : "split" });
			else if (key === "w") setPrefs({ wrap: !prefs.wrap });
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	});

	if (error) return html`<div class="page"><${Empty} title="Changes not found">${error}<//></div>`;
	if (!changeset) return html`<div class="page"><div class="empty small">Loading changes…</div></div>`;

	const session = sessionOf(changeset.sessionId);
	const color = colorOf(session);
	const queue = openChangesets();
	const queueIndex = queue.findIndex((c) => c.id === id);
	const nextOpen = queue.find((c) => c.id !== id);
	const wholeReverted = Boolean(model && model.blocks && rejected.size >= model.blocks);
	const fallbackTitle = changeset.kind === "turn" ? "Turn changes" : "Changes made by bash";

	return html`<div class="page review-page" style=${`--c:${color}`}>
		<div class="review-top">
			<${ChangesetStatus} value=${result?.status ?? status} />
			${session ? html`<${SessionChip} session=${session} showStatus=${true} onClick=${() => navigate(`#/agents/${encodeURIComponent(session.id)}`)} />` : null}
			<${ChangesetKind} kind=${changeset.kind} />
			<${DiffStat} ...${changeset.stats ?? { added: 0, removed: 0 }} />
			<span class="tiny faint">${files.length} file${files.length === 1 ? "" : "s"} · ${timeAgo(changeset.createdAt)}</span>
			<span class="spacer"></span>
			${queue.length > 1 || (queue.length === 1 && queueIndex === -1) ? html`<span class="small muted">${queueIndex >= 0 ? `${queueIndex + 1} / ${queue.length} open` : `${queue.length} open`}</span>` : null}
			<div class="segmented flat">
				<button class=${prefs.mode === "split" ? "on" : ""} onClick=${() => setPrefs({ mode: "split" })}>split</button>
				<button class=${prefs.mode === "unified" ? "on" : ""} onClick=${() => setPrefs({ mode: "unified" })}>unified</button>
			</div>
			<div class="segmented flat">
				<button class=${prefs.wrap ? "on" : ""} onClick=${() => setPrefs({ wrap: !prefs.wrap })}>wrap</button>
			</div>
		</div>

		<div class="cs-title-card">
			<span class="cs-title-label">${changeset.kind === "bash" ? "$" : "prompt"}</span>
			<div class=${`cs-title ${changeset.kind === "bash" ? "mono" : ""}`} title=${changeset.title}>${changeset.title || fallbackTitle}</div>
			${changeset.root ? html`<span class="tiny faint mono ellipsis cs-root" title=${changeset.root}>${changeset.root}</span>` : null}
		</div>

		<div class="cs-body">
			<div class="cs-side">
				<div class="card cs-files">
					<div class="row cs-files-head">
						<span class="small muted">Files</span>
						<span class="spacer"></span>
						<span class="tiny faint"><kbd>j</kbd> <kbd>k</kbd></span>
					</div>
					<div class="cs-file-list">
						${files.map(
							(f, i) => html`<${FileRow}
								key=${f.path}
								file=${f}
								model=${models.get(f.path)}
								rejected=${revertedBlocks(f, models.get(f.path), whole, hunks)}
								selected=${i === index}
								decided=${!actionable}
								outcome=${outcomeOf(f.path)}
								onSelect=${() => setSelected(i)}
							/>`,
						)}
					</div>
				</div>

				${actionable
					? html`<div class="card cs-decide">
							<textarea class="input" rows="3" placeholder="Note for the agent (optional)…" value=${comment} onInput=${(e) => setComment(e.target.value)}></textarea>
							<div class="tiny faint">${plan.length ? `${plan.length} file${plan.length === 1 ? "" : "s"} will be reverted (fully or partly). Others are kept as-is.` : "Toggle hunks or whole files to revert them. Everything else stays on disk."}</div>
							<div class="decision-bar">
								<button class="btn ok" disabled=${busy} onClick=${() => resolve(true)}>Keep all</button>
								<button class="btn bad" disabled=${busy || !plan.length} onClick=${() => resolve(false)}>Apply reverts${plan.length ? ` (${plan.length})` : ""}</button>
							</div>
						</div>`
					: html`<div class="card cs-decide">
							<div class="row"><span class="small muted">Outcome</span><span class="spacer"></span><${ChangesetStatus} value=${result?.status ?? status} /></div>
							${outcomes.length
								? html`<div class="col" style="gap:4px">
										${outcomes.map(
											(o) => html`<div class="cs-outcome">
												<span class=${`cs-outcome-dot ${outcomeTone(o.result)}`}></span>
												<span class="mono tiny ellipsis" title=${o.path}>${o.path}</span>
												<span class=${`tiny cs-outcome-text ${outcomeTone(o.result)}`}>${o.result}</span>
											</div>`,
										)}
									</div>`
								: html`<div class="tiny faint">All changes were kept.</div>`}
							${result ? html`<div class="tiny faint">${result.delivered ? "The agent was told about the reverts." : "No message was delivered to the agent."}</div>` : null}
							${changeset.comment || (result && comment.trim()) ? html`<div class="well small">${changeset.comment || comment.trim()}</div>` : null}
							${nextOpen ? html`<button class="btn sm primary" onClick=${() => navigate(`#/changeset/${nextOpen.id}`)}>Next open changes →</button>` : html`<button class="btn sm" onClick=${() => navigate("#/reviews")}>Back to Diff review</button>`}
						</div>`}
			</div>

			<div class="card diff-card">
				${file
					? html`<div class="file-head">
							<span class=${`tool-tag ${file.status === "added" ? "new" : file.status === "deleted" ? "del" : ""}`}>${file.status.toUpperCase()}</span>
							<span class="file-path" title=${file.absPath}><span class="dir">${dirName(file.path)}</span>${baseName(file.path)}</span>
							${model ? html`<${DiffStat} ...${stats(model.ops)} />` : null}
							<span class="spacer"></span>
							${actionable && rejected.size && !wholeReverted ? html`<span class="pill warn">${rejected.size} of ${model.blocks} hunks reverted</span>` : null}
							${actionable && model && model.blocks
								? html`<button class=${`btn sm ${wholeReverted ? "bad" : ""}`} title="Revert the whole file (r)" onClick=${toggleWhole}>
										${wholeReverted ? "✓ Reverting file" : file.status === "added" ? "Revert file (delete)" : file.status === "deleted" ? "Revert file (restore)" : "Revert file"}
									</button>`
								: null}
						</div>`
					: null}
				<div class="diff-scroll">
					${!file
						? html`<div class="empty small">No files in this changeset.</div>`
						: !isText(file)
							? html`<div class="empty small">${file.binary ? "Binary file" : "File too large to diff"} — it can only be kept as-is from here.</div>`
							: html`<${DiffViewer}
									key=${file.path}
									oldText=${file.before ?? ""}
									newText=${file.after ?? ""}
									path=${file.path}
									mode=${prefs.mode}
									wrap=${prefs.wrap}
									context=${prefs.context}
									rejected=${actionable ? rejected : new Set()}
									onToggleBlock=${actionable ? toggleBlock : undefined}
									blockLabels=${REVERT_LABELS}
								/>`}
				</div>
			</div>
		</div>
	</div>`;
}
