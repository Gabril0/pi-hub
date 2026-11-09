import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js";
import { alignBlock, buildHunks, contentWithBlocks, diffOps, escape, highlightLines, languageFor, pairRows, smartCollapse, stats, wordDiff } from "../lib/diff.js";
import { api, pendingReviews, sessionOf, sorted, useStore } from "../lib/store.js";
import { Icon } from "../lib/icons.js";
import { Empty, Markdown, Modal, SessionChip, Status, colorOf, isTyping, navigate, sessionName, timeAgo } from "../lib/util.js";

function DiffStat({ added, removed }) {
	const total = added + removed || 1;
	const boxes = 5;
	const a = Math.round((added / total) * boxes);
	const d = Math.min(boxes - a, Math.round((removed / total) * boxes));
	return html`<span class="diffstat">
		<span class="plus">+${added}</span><span class="minus">−${removed}</span>
		<span class="boxes">${Array.from({ length: boxes }, (_, i) => html`<i class=${i < a ? "a" : i < a + d ? "d" : ""}></i>`)}</span>
	</span>`;
}

function Marked({ spans }) {
	return spans.map((s) => (s.mark ? html`<mark class="wd">${s.text}</mark>` : s.text));
}

function markRanges(spans) {
	const ranges = [];
	const text = spans.map((s) => s.text).join("");
	let pos = 0;
	for (const span of spans) {
		if (span.mark && span.text.length) {
			const last = ranges.at(-1);
			const gap = last ? text.slice(last[1], pos) : "";
			if (last && gap.length <= 1 && !gap.trim()) last[1] = pos + span.text.length;
			else ranges.push([pos, pos + span.text.length]);
		}
		pos += span.text.length;
	}
	return ranges;
}

function markHighlighted(markup, spans) {
	if (!markup) return undefined;
	const template = document.createElement("template");
	template.innerHTML = markup;
	if (template.content.textContent !== spans.map((s) => s.text).join("")) return undefined;
	const ranges = markRanges(spans);
	if (!ranges.length) return markup;
	const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	let offset = 0;
	for (const node of nodes) {
		const start = offset;
		const end = offset + node.data.length;
		offset = end;
		const cuts = ranges.filter(([a, b]) => a < end && b > start).map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start]);
		if (!cuts.length) continue;
		const fragment = document.createDocumentFragment();
		let cursor = 0;
		for (const [a, b] of cuts) {
			if (a > cursor) fragment.append(node.data.slice(cursor, a));
			const mark = document.createElement("mark");
			mark.className = "wd";
			mark.textContent = node.data.slice(a, b);
			fragment.append(mark);
			cursor = b;
		}
		if (cursor < node.data.length) fragment.append(node.data.slice(cursor));
		node.replaceWith(fragment);
	}
	return template.innerHTML;
}

function CodeCell({ op, side, hl, marks, cls = "" }) {
	const spans = op ? marks?.get(op)?.[side] : undefined;
	const lineNo = op ? (side === "left" ? op.oldNo : (op.newNo ?? op.oldNo)) : undefined;
	const source = side === "left" ? hl.old : hl.new;
	const markup = op ? (source[(lineNo ?? 1) - 1] ?? escape(op.text)) : "";
	const marked = useMemo(() => (spans ? markHighlighted(markup, spans) : undefined), [markup, spans]);
	if (!op) return html`<td class=${`code empty ${cls}`}></td>`;
	if (spans && marked === undefined) return html`<td class=${`code ${cls}`}><${Marked} spans=${spans} /></td>`;
	return html`<td class=${`code ${cls}`} dangerouslySetInnerHTML=${{ __html: (marked ?? markup) || " " }}></td>`;
}

function SideCells({ split, side, children }) {
	if (!split) return html`<td colspan="4">${children}</td>`;
	return html`<td colspan="3" class=${side === "old" ? "" : "blank"}>${side === "old" ? children : null}</td>
		<td colspan="3" class=${side === "new" ? "" : "blank"}>${side === "new" ? children : null}</td>`;
}

function CommentRows({ comments, side, line, split, onRemove }) {
	const list = comments.filter((c) => c.side === side && c.line === line);
	return list.map(
		(c) => html`<tr class=${`comment-row ${split ? "side-split" : ""}`}>
			<${SideCells} split=${split} side=${side}>
				<div class="line-comment"><span>💬</span><span style="flex:1">${c.text}</span>${onRemove ? html`<button class="btn sm ghost" title="Remove comment" onClick=${() => onRemove(c)}>×</button>` : null}</div>
			<//>
		</tr>`,
	);
}

function DraftRow({ draft, split, onSave, onCancel }) {
	const [text, setText] = useState("");
	const ref = useRef();
	useEffect(() => ref.current?.focus(), []);
	const save = () => text.trim() && onSave(text.trim());
	return html`<tr class=${`comment-row ${split ? "side-split" : ""}`}>
		<${SideCells} split=${split} side=${draft.side}>
			<div class="col draft-box">
				<textarea
					ref=${ref}
					class="input"
					rows="2"
					placeholder=${`Comment on ${draft.side === "old" ? "original" : "proposed"} line ${draft.line}… (Enter to add, Esc to cancel)`}
					value=${text}
					onInput=${(e) => setText(e.target.value)}
					onKeyDown=${(e) => {
						e.stopPropagation();
						if (e.key === "Escape") onCancel();
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							save();
						}
					}}
				></textarea>
				<div class="row">
					<span class="spacer"></span>
					<button class="btn sm ghost" onClick=${onCancel}>Cancel</button>
					<button class="btn sm primary" disabled=${!text.trim()} onClick=${save}>Save comment</button>
				</div>
			</div>
		<//>
	</tr>`;
}

function shortValue(value) {
	return value.length > 12 ? `${value.slice(0, 10)}…` : value;
}

function CollapseSummary({ summary, open, onToggle }) {
	const keys = summary.keys ?? [];
	return html`<span class="collapse-summary">
		<span class="pill accent">${summary.lines} lines</span>
		<span class="tiny muted">${summary.from.length} distinct → ${summary.to.length}</span>
		${summary.from.slice(0, 2).map((t) => html`<code class="from" title=${t}>${shortValue(t)}</code>`)}
		→ ${summary.to.slice(0, 2).map((t) => html`<code class="to" title=${t}>${shortValue(t)}</code>`)}
		${keys.length
			? html`<span class="tiny muted collapse-keys" title=${keys.join(", ")}>${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ` +${keys.length - 3}` : ""}</span>`
			: null}
		<button class="btn sm" onClick=${onToggle}>${open ? "▾ hide lines" : "▸ show lines"}</button>
	</span>`;
}

function GapRow({ gap, colSpan, onExpand }) {
	const n = gap.hidden;
	const label = `${n} hidden line${n === 1 ? "" : "s"}`;
	return html`<tr class="gap"><td colspan=${colSpan}>
		<div class="gap-btns">
			${n <= 20
				? html`<button onClick=${() => onExpand(gap, "all")}>Show ${label}</button>`
				: html`<button title="Show 20 more lines below the previous hunk" onClick=${() => onExpand(gap, "down")}>↓ 20</button>
						<button title=${`Show all ${label}`} onClick=${() => onExpand(gap, "all")}>⇕ Show all ${n}</button>
						<button title="Show 20 more lines above the next hunk" onClick=${() => onExpand(gap, "up")}>↑ 20</button>`}
		</div>
	</td></tr>`;
}

export function DiffViewer({
	oldText,
	newText,
	path,
	mode = "split",
	wrap = false,
	ignoreWhitespace = false,
	context = 3,
	rejected = new Set(),
	onToggleBlock,
	comments = [],
	onAddComment,
	onRemoveComment,
	focusBlock,
	onModel,
}) {
	const [expanded, setExpanded] = useState(new Map());
	const [openCollapsed, setOpenCollapsed] = useState(new Set());
	const [draft, setDraft] = useState(null);
	const model = useMemo(() => diffOps(oldText, newText, { ignoreWhitespace }), [oldText, newText, ignoreWhitespace]);
	const language = useMemo(() => languageFor(path), [path]);
	const hl = useMemo(() => ({ old: highlightLines(oldText, language), new: highlightLines(newText, language) }), [oldText, newText, language]);
	const collapsed = useMemo(() => smartCollapse(model.ops), [model]);
	const items = useMemo(() => buildHunks(model.ops, context, expanded), [model, context, expanded]);
	const marks = useMemo(() => {
		const map = new Map();
		const blocks = new Map();
		for (const op of model.ops) {
			if (op.type === "ctx") continue;
			const entry = blocks.get(op.block) ?? { dels: [], adds: [] };
			(op.type === "del" ? entry.dels : entry.adds).push(op);
			blocks.set(op.block, entry);
		}
		for (const { dels, adds } of blocks.values()) {
			for (const [del, add] of alignBlock(dels, adds)) {
				if (!del || !add) continue;
				const wd = wordDiff(del.text, add.text);
				if (!wd) continue;
				map.set(del, { left: wd.left });
				map.set(add, { right: wd.right });
			}
		}
		return map;
	}, [model]);

	useEffect(() => onModel?.(model), [model]);
	useEffect(() => {
		if (focusBlock == null) return;
		document.querySelector(`[data-block="${focusBlock}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [focusBlock]);

	const expandGap = (gap, how) => {
		const next = new Map(expanded);
		const current = next.get(gap.id) ?? { top: 0, bottom: 0 };
		if (how === "all") next.set(gap.id, "all");
		else if (how === "up") next.set(gap.id, { ...current, bottom: current.bottom + 20 });
		else next.set(gap.id, { ...current, top: current.top + 20 });
		setExpanded(next);
	};

	const commentable = Boolean(onAddComment);
	const startComment = (side, op) => {
		if (!commentable || !op) return;
		const target = op.type === "ctx" ? "new" : side;
		const line = target === "old" ? op.oldNo : op.newNo;
		if (!line) return;
		setDraft({ side: target, line, snippet: op.text });
	};
	const saveDraft = (text) => {
		onAddComment({ ...draft, text });
		setDraft(null);
	};

	const split = mode === "split";
	const colSpan = split ? 6 : 4;
	const rows = [];
	const seenBlocks = new Set();
	const focusCls = (block) => (block != null && focusBlock === block ? "block-focus" : "");

	const hunkLabel = (block) => {
		const index = model.ops.findIndex((op) => op.block === block);
		const ops = model.ops.filter((op) => op.block === block);
		const before = model.ops.slice(0, index).reverse().find((op) => op.type === "ctx");
		const oldStart = ops.find((op) => op.oldNo)?.oldNo ?? (before ? before.oldNo + 1 : 1);
		const newStart = ops.find((op) => op.newNo)?.newNo ?? (before ? before.newNo + 1 : 1);
		const removed = ops.filter((op) => op.type === "del").length;
		const added = ops.filter((op) => op.type === "add").length;
		return `@@ -${oldStart}${removed === 1 ? "" : `,${removed}`} +${newStart}${added === 1 ? "" : `,${added}`} @@`;
	};

	const blockHead = (block) => {
		if (block == null || seenBlocks.has(block)) return;
		seenBlocks.add(block);
		const summary = collapsed.get(block);
		const isOpen = openCollapsed.has(block);
		const off = rejected.has(block);
		rows.push(html`<tr class=${`block-head ${focusCls(block)}`} data-block=${block}>
			<td colspan=${colSpan}>
				<div class="row">
					<span class="hunk-label">${hunkLabel(block)}</span>
					${onToggleBlock
						? html`<span class=${`block-toggle ${off ? "off" : ""}`} onClick=${() => onToggleBlock(block)} title="Include this change when approving">
								<span class="box">✓</span>${off ? "excluded — keeps original" : "include"}
							</span>`
						: null}
					${summary
						? html`<${CollapseSummary}
								summary=${summary}
								open=${isOpen}
								onToggle=${() => {
									const next = new Set(openCollapsed);
									isOpen ? next.delete(block) : next.add(block);
									setOpenCollapsed(next);
								}}
							/>`
						: null}
				</div>
			</td>
		</tr>`);
	};
	const hidden = (op) => op && op.type !== "ctx" && collapsed.has(op.block) && !openCollapsed.has(op.block);

	const gapRow = (gap) => rows.push(html`<${GapRow} gap=${gap} colSpan=${colSpan} onExpand=${expandGap} />`);

	const afterLine = (side, line) => {
		rows.push(html`<${CommentRows} comments=${comments} side=${side} line=${line} split=${split} onRemove=${onRemoveComment} />`);
		if (draft && draft.side === side && draft.line === line) rows.push(html`<${DraftRow} draft=${draft} split=${split} onSave=${saveDraft} onCancel=${() => setDraft(null)} />`);
	};

	if (split) {
		for (const row of pairRows(items)) {
			if (row.kind === "gap") {
				gapRow(row);
				continue;
			}
			const { left, right } = row;
			const changed = left?.type !== "ctx" || right?.type !== "ctx";
			if (changed) blockHead(row.block);
			if (changed && (hidden(left) || hidden(right))) continue;
			const leftCls = left?.type === "del" ? "del" : "";
			const rightCls = right?.type === "add" ? "add" : "";
			const isRejected = changed && rejected.has(row.block);
			rows.push(html`<tr class=${`${isRejected ? "rejected" : ""} ${changed ? focusCls(row.block) : ""}`} data-block=${changed ? row.block : undefined}>
				<td class=${`num l ${leftCls}`} onClick=${() => startComment("old", left)}>${left?.oldNo ?? ""}</td>
				<td class=${`sign l ${leftCls}`}>${leftCls ? "−" : ""}</td>
				<${CodeCell} op=${left} side="left" hl=${hl} marks=${marks} cls=${`left l ${leftCls}`} />
				<td class=${`num r ${rightCls}`} onClick=${() => startComment("new", right)}>${right?.newNo ?? ""}</td>
				<td class=${`sign r ${rightCls}`}>${rightCls ? "+" : ""}</td>
				<${CodeCell} op=${right} side="right" hl=${hl} marks=${marks} cls=${`r ${rightCls}`} />
			</tr>`);
			if (left?.oldNo && left.type === "del") afterLine("old", left.oldNo);
			if (right?.newNo) afterLine("new", right.newNo);
		}
	} else {
		for (const item of items) {
			if (item.kind === "gap") {
				gapRow(item);
				continue;
			}
			const op = item.op;
			if (op.type !== "ctx") blockHead(op.block);
			if (hidden(op)) continue;
			const cls = op.type === "ctx" ? "" : op.type;
			const isRejected = op.type !== "ctx" && rejected.has(op.block);
			rows.push(html`<tr class=${`${cls} ${isRejected ? "rejected" : ""} ${op.type !== "ctx" ? focusCls(op.block) : ""}`} data-block=${op.type !== "ctx" ? op.block : undefined}>
				<td class="num" onClick=${() => startComment("old", op)}>${op.oldNo ?? ""}</td>
				<td class="num" onClick=${() => startComment(op.type === "del" ? "old" : "new", op)}>${op.newNo ?? ""}</td>
				<td class="sign">${op.type === "add" ? "+" : op.type === "del" ? "−" : ""}</td>
				<${CodeCell} op=${op} side=${op.type === "del" ? "left" : "right"} hl=${hl} marks=${marks} />
			</tr>`);
			if (op.type === "del") afterLine("old", op.oldNo);
			else afterLine("new", op.newNo);
		}
	}

	if (!model.blocks) {
		return html`<div class="empty small">No textual changes${ignoreWhitespace ? " (whitespace ignored)" : ""}.</div>`;
	}
	return html`<table class=${`diff ${split ? "side-by-side" : "unified"} ${wrap ? "wrap" : ""} ${commentable ? "commentable" : ""}`}>
		<colgroup>
			${split
				? html`<col style="width:56px" /><col style="width:26px" /><col /><col style="width:56px" /><col style="width:26px" /><col />`
				: html`<col style="width:56px" /><col style="width:56px" /><col style="width:26px" /><col />`}
		</colgroup>
		<tbody>${rows}</tbody>
	</table>`;
}

function useFullReview(id, updatedAt) {
	const [review, setReview] = useState(null);
	const [error, setError] = useState(null);
	useEffect(() => {
		let alive = true;
		api("GET", `/api/reviews/${id}`)
			.then(({ review }) => alive && setReview(review))
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, [id, updatedAt]);
	return { review, error };
}

function defaultPrefs() {
	return { mode: window.innerWidth < 1440 ? "unified" : "split", wrap: true, ignoreWhitespace: false, context: 3 };
}

function loadPrefs() {
	try {
		return { ...defaultPrefs(), ...JSON.parse(localStorage.getItem("pi-hub-diff") ?? "{}") };
	} catch {
		return defaultPrefs();
	}
}

function savePrefs(prefs) {
	try {
		localStorage.setItem("pi-hub-diff", JSON.stringify(prefs));
	} catch {}
}

const reviewMemory = new Map();

function rememberReview(id, entry) {
	if (!entry.draft.trim() && !entry.comments.length && !entry.rejected.size) reviewMemory.delete(id);
	else reviewMemory.set(id, entry);
}

function hasUnsent(id) {
	const entry = reviewMemory.get(id);
	return Boolean(entry && (entry.draft.trim() || entry.comments.length));
}

function truncate(text, max) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function Help({ onClose }) {
	const keys = [
		["a", "approve (applies included changes)"],
		["d", "deny — the draft becomes the deny note"],
		["j / k", "next / previous change"],
		["x", "include / exclude focused change"],
		["n / p", "next / previous pending review"],
		["s", "split ⇄ unified"],
		["w", "toggle wrap"],
		["c", "focus the negotiate box"],
		["Enter", "ask a question"],
		["Ctrl+Enter", "request a change (revised in place)"],
		["click line #", "comment on a line"],
	];
	return html`<${Modal} onClose=${onClose}>
		<h2 style="margin-bottom:14px">Keyboard</h2>
		<div class="kbd-help">${keys.map(([k, v]) => html`<kbd>${k}</kbd><span class="muted">${v}</span>`)}</div>
	<//>`;
}

function dirOf(path) {
	const normalized = String(path ?? "").replace(/\\/g, "/");
	const index = normalized.lastIndexOf("/");
	return index === -1 ? "" : normalized.slice(0, index + 1);
}

function baseOf(path) {
	const normalized = String(path ?? "").replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function AgentMessage({ session, suffix, children }) {
	return html`<div class="msg agent">
		<div class="msg-who">${session ? sessionName(session) : "agent"}${suffix ? ` · ${suffix}` : ""}</div>
		<div class="bubble agent">${children}</div>
	</div>`;
}

export function ReviewView({ id }) {
	const state = useStore();
	const summary = state.reviews.get(id);
	const { review, error } = useFullReview(id, summary?.updatedAt);
	const memory = reviewMemory.get(id);
	const [prefs, setPrefsState] = useState(loadPrefs);
	const [selectedRev, setSelectedRev] = useState(null);
	const [compare, setCompare] = useState("base");
	const [rejected, setRejected] = useState(() => memory?.rejected ?? new Set());
	const [comments, setComments] = useState(() => memory?.comments ?? []);
	const [draft, setDraft] = useState(() => memory?.draft ?? "");
	const [focusBlock, setFocusBlock] = useState(null);
	const [blocks, setBlocks] = useState(0);
	const [model, setModel] = useState(null);
	const [help, setHelp] = useState(false);
	const [busy, setBusy] = useState(false);
	const chatRef = useRef();
	const inputRef = useRef();
	const lastRevCount = useRef(memory?.revisions ?? 0);
	const decided = useRef(false);

	const setPrefs = (patch) => {
		const next = { ...prefs, ...patch };
		setPrefsState(next);
		savePrefs(next);
	};

	const revisions = review?.revisions ?? [];
	const latestIndex = revisions.length - 1;
	const revIndex = selectedRev == null || selectedRev > latestIndex ? latestIndex : selectedRev;

	useEffect(() => {
		if (!review) return;
		if (revisions.length !== lastRevCount.current) {
			lastRevCount.current = revisions.length;
			setSelectedRev(null);
			setRejected(new Set());
		}
	}, [review, revisions.length]);

	useEffect(() => {
		if (decided.current) return;
		rememberReview(id, { draft, comments, rejected, revisions: lastRevCount.current });
	}, [id, draft, comments, rejected, revisions.length]);

	useEffect(() => {
		if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
	}, [review?.chat?.length, summary?.status]);

	const session = sessionOf(summary?.sessionId ?? review?.sessionId);
	const color = colorOf(session);
	const status = summary?.status ?? review?.status;
	const actionable = status === "pending" || status === "thinking";
	const queue = pendingReviews();
	const queueIndex = queue.findIndex((r) => r.id === id);
	const othersUnsent = queue.some((r) => r.id !== id && hasUnsent(r.id));

	const current = revisions[revIndex];
	const baseText = compare === "prev" && revIndex > 0 ? revisions[revIndex - 1].content : (review?.oldContent ?? "");
	const newText = current?.content ?? "";
	const partialAllowed = compare === "base";
	const counts = model ? stats(model.ops) : { added: 0, removed: 0 };
	const allExcluded = Boolean(model && rejected.size && rejected.size >= model.blocks);

	const goNext = () => {
		const others = pendingReviews().filter((r) => r.id !== id);
		if (others.length) navigate(`#/review/${others[0].id}`);
	};

	const decide = async (decision) => {
		if (!actionable || busy) return;
		if (decision === "approve" && allExcluded) return;
		setBusy(true);
		try {
			const body = { decision, comment: draft.trim() || undefined, lineComments: comments };
			if (decision === "approve") {
				if (rejected.size && partialAllowed && model) body.content = contentWithBlocks(model.ops, rejected);
				else if (revIndex !== latestIndex) body.content = current.content;
			}
			await api("POST", `/api/reviews/${id}/decision`, body);
			decided.current = true;
			reviewMemory.delete(id);
			setDraft("");
			setComments([]);
			setTimeout(goNext, 350);
		} finally {
			setBusy(false);
		}
	};

	const send = async (kind) => {
		const text = draft.trim();
		if (!actionable || (!text && !comments.length)) return;
		await api("POST", `/api/reviews/${id}/${kind}`, { text: text || "Address my line comments.", lineComments: comments });
		setDraft("");
		setComments([]);
	};

	const toggleBlock = (block) => {
		if (!partialAllowed) return;
		const next = new Set(rejected);
		next.has(block) ? next.delete(block) : next.add(block);
		setRejected(next);
	};

	useEffect(() => {
		const onKey = (e) => {
			if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || help) return;
			const key = e.key.toLowerCase();
			if (key === "a") decide("approve");
			else if (key === "d") decide("deny");
			else if (key === "s") setPrefs({ mode: prefs.mode === "split" ? "unified" : "split" });
			else if (key === "w") setPrefs({ wrap: !prefs.wrap });
			else if (key === "c") (e.preventDefault(), inputRef.current?.focus());
			else if (key === "j") setFocusBlock((b) => Math.min((b ?? -1) + 1, Math.max(0, blocks - 1)));
			else if (key === "k") setFocusBlock((b) => Math.max((b ?? 1) - 1, 0));
			else if (key === "x" && focusBlock != null) toggleBlock(focusBlock);
			else if (key === "n" && queue.length) navigate(`#/review/${queue[(queueIndex + 1) % queue.length].id}`);
			else if (key === "p" && queue.length) navigate(`#/review/${queue[(queueIndex - 1 + queue.length) % queue.length].id}`);
			else if (key === "?") setHelp(true);
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	});

	if (error) return html`<div class="page"><${Empty} title="Review not found">${error}<//></div>`;
	if (!review) return html`<div class="page"><div class="empty small">Loading review…</div></div>`;

	const statusLabel = { pending: "review needed", thinking: "agent is thinking", approved: "approved", denied: "denied", cancelled: "cancelled", stale: "stale — agent restarted" }[status] ?? status;
	const chat = review.chat ?? [];
	const approveDisabled = !actionable || busy || allExcluded;
	const canSend = actionable && status !== "thinking" && Boolean(draft.trim() || comments.length);

	return html`<div class="page review-page" style=${`--c:${color}`}>
		<div class="review-top">
			<span class=${`review-badge ${status}`}><span class="dot" style=${`--c:${status === "approved" ? "var(--ok)" : status === "denied" ? "var(--bad)" : "var(--warn)"}`}></span>${statusLabel}</span>
			${session ? html`<${SessionChip} session=${session} showStatus=${true} onClick=${() => navigate(`#/agents/${encodeURIComponent(session.id)}`)} />` : null}
			${review.auto ? html`<span class="pill">auto-approved · ${review.auto}</span>` : null}
			${review.applied === true ? html`<span class="pill ok">applied</span>` : review.applied === false ? html`<span class="pill bad">apply failed</span>` : null}
			${review.partial ? html`<span class="pill accent">partially approved</span>` : null}
			<span class="tiny faint">${timeAgo(review.createdAt)}</span>
			<span class="spacer"></span>
			${queue.length > 1 || (queue.length === 1 && queueIndex === -1)
				? html`<div class="row small muted pager">
						<button class="btn sm" title="Previous pending review (p)" onClick=${() => navigate(`#/review/${queue[(queueIndex - 1 + queue.length) % queue.length].id}`)}>‹</button>
						${queueIndex >= 0 ? `${queueIndex + 1} / ${queue.length}` : `${queue.length} pending`}
						${othersUnsent ? html`<span class="unsent-dot" title="Other reviews have unsent drafts"></span>` : null}
						<button class="btn sm" title="Next pending review (n)" onClick=${() => navigate(`#/review/${queue[(queueIndex + 1) % queue.length].id}`)}>›</button>
					</div>`
				: null}
			<div class="segmented flat">
				<button class=${prefs.mode === "split" ? "on" : ""} onClick=${() => setPrefs({ mode: "split" })}>split</button>
				<button class=${prefs.mode === "unified" ? "on" : ""} onClick=${() => setPrefs({ mode: "unified" })}>unified</button>
			</div>
			<div class="segmented flat">
				<button class=${prefs.wrap ? "on" : ""} onClick=${() => setPrefs({ wrap: !prefs.wrap })}>wrap</button>
				<button class=${prefs.ignoreWhitespace ? "on" : ""} onClick=${() => setPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace })}>ignore ws</button>
			</div>
			<div class="segmented" title="Context lines">
				<button onClick=${() => setPrefs({ context: Math.max(0, prefs.context - 2) })}>−</button>
				<button class="on">${prefs.context}</button>
				<button onClick=${() => setPrefs({ context: prefs.context + 2 })}>+</button>
			</div>
			<button class="btn sm icon" onClick=${() => setHelp(true)}>?</button>
		</div>

		${review.conflicts?.length
			? html`<div class="conflict-banner">⚠ Also touched by ${review.conflicts.map((c) => html`<span class="pill" style=${`color:${c.color?.hex}`}>● ${c.name}</span>`)} — coordinate before approving.</div>`
			: null}

		<div class="review-body">
			<div class="card diff-card">
				<div class="file-head">
					<span class=${`tool-tag ${review.isNew ? "new" : ""}`}>${review.isNew ? "NEW" : review.tool.toUpperCase()}</span>
					<span class="file-path" title=${review.absPath}><span class="dir">${dirOf(review.absPath || review.path)}</span>${baseOf(review.absPath || review.path)}</span>
					<button class="btn sm ghost" onClick=${() => navigator.clipboard?.writeText(review.absPath)}>copy</button>
					<${DiffStat} ...${counts} />
					<span class="spacer"></span>
					<span class="lang-tag">${(review.path.split(".").pop() || "txt").toLowerCase()}</span>
					${focusBlock != null && blocks ? html`<span class="pill accent">change ${focusBlock + 1} / ${blocks}</span>` : null}
					${rejected.size ? html`<span class="pill warn">${rejected.size} of ${blocks} changes excluded</span>` : null}
				</div>
				${revisions.length > 1
					? html`<div class="revision-bar">
							<span class="small muted">Revisions</span>
							<div class="segmented">
								${revisions.map((r, i) => html`<button class=${i === revIndex ? "on" : ""} title=${r.note} onClick=${() => setSelectedRev(i)}>v${r.n}${i === latestIndex ? " ★" : ""}</button>`)}
							</div>
							<div class="segmented">
								<button class=${compare === "base" ? "on" : ""} onClick=${() => setCompare("base")}>vs original</button>
								<button class=${compare === "prev" ? "on" : ""} disabled=${revIndex === 0} onClick=${() => setCompare("prev")}>vs previous</button>
							</div>
							<span class="small faint ellipsis" style="flex:1">${current?.note}</span>
						</div>`
					: null}
				<div class="diff-scroll">
					${review.contentDropped
						? html`<div class="empty small">Content for this old review was pruned.</div>`
						: html`<${DiffViewer}
								key=${`${revIndex}-${compare}`}
								oldText=${baseText}
								newText=${newText}
								path=${review.path}
								mode=${prefs.mode}
								wrap=${prefs.wrap}
								ignoreWhitespace=${prefs.ignoreWhitespace}
								context=${prefs.context}
								rejected=${partialAllowed ? rejected : new Set()}
								onToggleBlock=${actionable && partialAllowed ? toggleBlock : undefined}
								comments=${comments}
								onAddComment=${actionable ? (c) => setComments([...comments, c]) : undefined}
								onRemoveComment=${(c) => setComments(comments.filter((x) => x !== c))}
								focusBlock=${focusBlock}
								onModel=${(m) => {
									setModel(m);
									setBlocks(m.blocks);
								}}
							/>`}
				</div>
			</div>

			<div class="review-side">
			<div class="card negotiate">
				<div>
					<h3>Negotiate</h3>
					<div class="negotiate-sub">Ask about the change or request edits. The agent revises the diff in place.</div>
				</div>
				<div class="chat" ref=${chatRef}>
					${review.reason ? html`<${AgentMessage} session=${session}>${review.reason}<//>` : null}
					${chat.map((m) =>
						m.role === "agent"
							? html`<${AgentMessage} session=${session} suffix=${m.revision ? `v${m.revision}` : ""}><${Markdown} text=${m.text} /><//>`
							: m.role === "system"
								? html`<div class="bubble system">${m.text}</div>`
								: html`<div class="msg user">
										<div class="msg-who">${m.kind === "revise" ? "you · change request" : "you"}</div>
										<div class="bubble user">
											${m.text}
											${m.lineComments?.length ? html`<div class="tiny" style="margin-top:6px;opacity:.85">${m.lineComments.map((c) => html`<div>L${c.line}: ${c.text}</div>`)}</div>` : null}
										</div>
									</div>`,
					)}
					${status === "thinking" ? html`<${AgentMessage} session=${session}><div class="typing"><span></span><span></span><span></span></div><//>` : null}
					${!chat.length && status !== "thinking" && !review.reason ? html`<div class="small faint" style="margin:auto;text-align:center">No conversation yet.<br />Click a line number to comment on it.</div>` : null}
					${review.comment ? html`<div class="msg user"><div class="msg-who">you · ${status}</div><div class="bubble user">${review.comment}</div></div>` : null}
				</div>
				${comments.length
					? html`<div class="row wrap">
							${comments.map(
								(c) => html`<span class="pill accent comment-chip" title=${c.text}>
									L${c.line} (${c.side === "old" ? "orig" : "new"}) — ${truncate(c.text, 30)}
									<a style="cursor:pointer" title="Remove comment" onClick=${() => setComments(comments.filter((x) => x !== c))}>×</a>
								</span>`,
							)}
						</div>`
					: null}
				<div class="col" style="gap:6px">
					<div class="composer">
						<textarea
							ref=${inputRef}
							class="input"
							rows="1"
							disabled=${!actionable}
							placeholder=${actionable ? "Ask a question or request a change…" : "This review is closed."}
							value=${draft}
							onInput=${(e) => {
								setDraft(e.target.value);
								e.target.style.height = "auto";
								e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
							}}
							onKeyDown=${(e) => {
								if (e.key === "Escape") e.target.blur();
								if (e.key !== "Enter" || e.shiftKey) return;
								e.preventDefault();
								send(e.ctrlKey || e.metaKey ? "revise" : "ask");
							}}
						></textarea>
						<button class="send-btn" title="Send question (Enter)" disabled=${!canSend} onClick=${() => send("ask")}><${Icon} name="send" size=${16} /></button>
						<button class="send-btn alt" title="Request a change, revised in place (Ctrl+Enter)" disabled=${!canSend} onClick=${() => send("revise")}><${Icon} name="revise" size=${16} /></button>
					</div>
					<div class="key-hint" title="Enter sends a question · Ctrl+Enter requests a change · Shift+Enter adds a newline · the draft becomes the deny note if you deny">
						<span><kbd>Enter</kbd> send</span>·<span><kbd>⇧ Enter</kbd> newline</span>·<span><kbd>Ctrl ↵</kbd> change</span>·<span>draft = deny note</span>
					</div>
				</div>
			</div>
			<div class="decision-bar">
				<button class="btn bad" disabled=${!actionable || busy} onClick=${() => decide("deny")}>Deny <span class="k">D</span></button>
				<button class="btn ok" disabled=${approveDisabled} title=${allExcluded ? "All changes excluded — deny instead" : ""} onClick=${() => decide("approve")}>
					${rejected.size ? "Approve selected" : revIndex !== latestIndex ? `Approve v${current?.n}` : "Approve"} <span class="k">A</span>
				</button>
			</div>
			${allExcluded && actionable ? html`<div class="tiny decision-hint">All changes excluded — deny instead</div>` : null}
			</div>
		</div>
		${help ? html`<${Help} onClose=${() => setHelp(false)} />` : null}
	</div>`;
}

function ReviewRow({ review, showSession }) {
	return html`<a class="list-row" style=${`--c:${colorOf(review.sessionId)}`} href=${`#/review/${review.id}`}>
		${showSession ? html`<span class="dot" style=${`--c:${colorOf(review.sessionId)}`}></span>` : null}
		<span class=${`tool-tag ${review.isNew ? "new" : ""}`}>${review.isNew ? "NEW" : review.tool.toUpperCase()}</span>
		<span class="mono ellipsis" style="flex:1" title=${review.path}>${review.path}</span>
		${review.conflicts?.length ? html`<span class="pill warn" title="Also touched by other agents">⚠ conflict</span>` : null}
		${hasUnsent(review.id) ? html`<span class="pill accent">draft</span>` : null}
		${review.auto ? html`<span class="pill">auto</span>` : null}
		${review.revisions?.length > 1 ? html`<span class="pill accent">v${review.revisions.length}</span>` : null}
		${review.partial ? html`<span class="pill accent">partial</span>` : null}
		<${Status} value=${review.status} />
		<span class="tiny faint" style="width:40px;text-align:right">${timeAgo(review.createdAt)}</span>
	</a>`;
}

export function ReviewsView() {
	const state = useStore();
	const queue = pendingReviews();
	const [filter, setFilter] = useState(null);

	useEffect(() => {
		const onKey = (e) => {
			if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
			if ((e.key === "Enter" || e.key.toLowerCase() === "o") && queue.length) {
				e.preventDefault();
				navigate(`#/review/${queue[0].id}`);
			}
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	});

	const groups = new Map();
	for (const r of queue) {
		const list = groups.get(r.sessionId) ?? [];
		list.push(r);
		groups.set(r.sessionId, list);
	}
	const history = sorted(state.reviews)
		.filter((r) => r.status !== "pending" && r.status !== "thinking")
		.filter((r) => !filter || r.sessionId === filter)
		.slice(0, 120);
	const sessionIds = [...new Set(sorted(state.reviews).filter((r) => r.status !== "pending" && r.status !== "thinking").map((r) => r.sessionId))];

	return html`<div class="page">
		<div class="page-head">
			<div>
				<h1 class="page-title">Diff review</h1>
				<div class="page-sub">
					${queue.length
						? html`${queue.length} change${queue.length === 1 ? "" : "s"} waiting on you · <kbd>Enter</kbd> opens the first`
						: "Every edit and write from every agent is gated here. Nothing is waiting right now."}
				</div>
			</div>
		</div>
		${queue.length
			? html`<h3 class="section-title">Waiting on you</h3>
					<div class="card review-queue">
						${[...groups].map(
							([sid, list]) => html`<div class="queue-group" style=${`--c:${colorOf(sid)}`}>
								<div class="queue-group-head"><${SessionChip} id=${sid} static=${true} /><span class="tiny faint">${list.length} pending</span></div>
								${list.map((r) => html`<${ReviewRow} key=${r.id} review=${r} showSession=${false} />`)}
							</div>`,
						)}
					</div>`
			: null}
		<div class="row" style="margin:24px 0 12px">
			<div class="section-title">History</div>
			<span class="spacer"></span>
			<div class="row wrap">${sessionIds.map((sid) => html`<${SessionChip} id=${sid} on=${filter === sid} onClick=${() => setFilter(filter === sid ? null : sid)} />`)}</div>
		</div>
		${history.length
			? html`<div class="card" style="padding:8px">${history.map((r) => html`<${ReviewRow} key=${r.id} review=${r} showSession=${true} />`)}</div>`
			: queue.length
				? html`<div class="small faint">No decided reviews yet.</div>`
				: html`<${Empty} icon="◧" title="No reviews yet">When an agent edits or writes a file, the change lands here before touching disk.<//>`}
	</div>`;
}

export function SessionChanges({ sessionId }) {
	const state = useStore();
	const session = state.sessions.get(sessionId);
	const [files, setFiles] = useState(null);
	const [open, setOpen] = useState(new Set());
	const [mode, setMode] = useState("unified");
	const reviewCount = [...state.reviews.values()].filter((r) => r.sessionId === sessionId && r.status === "approved").length;
	useEffect(() => {
		api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/changes`)
			.then(({ files }) => setFiles(files.filter((f) => f.changed)))
			.catch(() => setFiles([]));
	}, [sessionId, reviewCount, session?.status]);
	if (!files) return null;
	return html`<div class="card">
		<div class="row" style="margin-bottom:10px">
			<h3>Session changes</h3>
			<span class="small faint">${files.length} file${files.length === 1 ? "" : "s"} vs. before this agent touched them</span>
			<span class="spacer"></span>
			<div class="segmented">
				<button class=${mode === "split" ? "on" : ""} onClick=${() => setMode("split")}>split</button>
				<button class=${mode === "unified" ? "on" : ""} onClick=${() => setMode("unified")}>unified</button>
			</div>
		</div>
		${files.length
			? files.map((f) => {
					const isOpen = open.has(f.absPath);
					const s = stats(diffOps(f.baseline, f.current).ops);
					return html`<div class="changes-file">
						<div class="changes-head" onClick=${() => {
							const next = new Set(open);
							isOpen ? next.delete(f.absPath) : next.add(f.absPath);
							setOpen(next);
						}}>
							<span>${isOpen ? "▾" : "▸"}</span>
							<span class="mono ellipsis" style="flex:1">${f.path}</span>
							${f.baseline && !f.exists ? html`<span class="pill bad">deleted</span>` : null}
							<${DiffStat} ...${s} />
						</div>
						${isOpen ? html`<div class="diff-scroll"><${DiffViewer} oldText=${f.baseline} newText=${f.current} path=${f.path} mode=${mode} wrap=${true} /></div>` : null}
					</div>`;
				})
			: html`<div class="small faint">No net file changes yet.</div>`}
	</div>`;
}
