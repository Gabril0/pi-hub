export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 62;
const GAP_Y = 24;
const GRID_GAP_X = 24;
const LABEL_WIDTH = 140;
const LABEL_HEIGHT = 14;

function assignRanks(ids, edges) {
	const outgoing = new Map(ids.map((id) => [id, []]));
	for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
	const state = new Map();
	const back = new Set();
	const visit = (id) => {
		state.set(id, 1);
		for (const next of outgoing.get(id) ?? []) {
			if (state.get(next) === 1) back.add(`${id}|${next}`);
			else if (!state.has(next)) visit(next);
		}
		state.set(id, 2);
	};
	const incoming = new Map(ids.map((id) => [id, 0]));
	for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	for (const id of [...ids].sort((a, b) => incoming.get(a) - incoming.get(b))) if (!state.has(id)) visit(id);
	const ranks = new Map(ids.map((id) => [id, 0]));
	const forward = edges.filter((edge) => !back.has(`${edge.from}|${edge.to}`));
	for (let pass = 0; pass < ids.length; pass++) {
		let moved = false;
		for (const edge of forward) {
			const wanted = ranks.get(edge.from) + 1;
			if (wanted > ranks.get(edge.to)) {
				ranks.set(edge.to, wanted);
				moved = true;
			}
		}
		if (!moved) break;
	}
	return ranks;
}

function orderColumns(columns, edges) {
	const neighbours = new Map();
	const link = (a, b) => neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
	for (const edge of edges) {
		link(edge.from, edge.to);
		link(edge.to, edge.from);
	}
	const position = new Map();
	const remember = () => columns.forEach((column) => column.forEach((id, index) => position.set(id, index)));
	remember();
	for (let sweep = 0; sweep < 6; sweep++) {
		const sequence = sweep % 2 ? [...columns].reverse() : columns;
		for (const column of sequence) {
			const weight = new Map(
				column.map((id) => {
					const places = (neighbours.get(id) ?? []).map((other) => position.get(other)).filter((value) => value !== undefined);
					return [id, places.length ? places.reduce((sum, value) => sum + value, 0) / places.length : position.get(id)];
				}),
			);
			column.sort((a, b) => weight.get(a) - weight.get(b));
			column.forEach((id, index) => position.set(id, index));
		}
	}
}

function bezierMiddle(x1, y1, c1x, c1y, c2x, c2y, x2, y2) {
	return { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + 3 * c1y + 3 * c2y + y2) / 8 };
}

function assignPorts(edges, placed) {
	const groups = new Map();
	const add = (key, entry) => groups.set(key, [...(groups.get(key) ?? []), entry]);
	for (const edge of edges) {
		add(`${edge.from}:out`, { edge, side: "start", other: placed.get(edge.to).y });
		add(`${edge.to}:in`, { edge, side: "end", other: placed.get(edge.from).y });
	}
	const offsets = new Map();
	for (const group of groups.values()) {
		group.sort((a, b) => a.other - b.other);
		group.forEach((entry, index) => {
			const spread = Math.min(10, (NODE_HEIGHT - 16) / Math.max(1, group.length));
			offsets.set(`${entry.edge.id}:${entry.side}`, (index - (group.length - 1) / 2) * spread);
		});
	}
	return offsets;
}

function routeEdge(edge, from, to, offsets) {
	const startY = from.y + NODE_HEIGHT / 2 + (offsets.get(`${edge.id}:start`) ?? 0);
	const endY = to.y + NODE_HEIGHT / 2 + (offsets.get(`${edge.id}:end`) ?? 0);
	let points;
	if (to.x > from.x) {
		const x1 = from.x + NODE_WIDTH;
		const x2 = to.x - 6;
		const bend = Math.max(40, (x2 - x1) / 2);
		points = [x1, startY, x1 + bend, startY, x2 - bend, endY, x2, endY];
	} else if (to.x < from.x) {
		const x1 = from.x;
		const x2 = to.x + NODE_WIDTH + 6;
		const drop = Math.max(from.y, to.y) + NODE_HEIGHT + 34;
		points = [x1, startY, x1 - 70, drop, x2 + 70, drop, x2, endY];
	} else {
		const x1 = from.x + NODE_WIDTH;
		const x2 = to.x + NODE_WIDTH + 6;
		const bulge = x1 + 54 + Math.abs(endY - startY) / 6;
		points = [x1, startY, bulge, startY, bulge, endY, x2, endY];
	}
	const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = points;
	const middle = bezierMiddle(x1, y1, c1x, c1y, c2x, c2y, x2, y2);
	return { ...edge, path: `M${x1} ${y1} C${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`, labelX: middle.x, labelY: middle.y };
}

function separateLabels(edges) {
	const placed = [];
	for (const edge of [...edges].sort((a, b) => a.labelY - b.labelY)) {
		for (const other of placed) {
			if (Math.abs(other.labelX - edge.labelX) < LABEL_WIDTH && Math.abs(other.labelY - edge.labelY) < LABEL_HEIGHT) edge.labelY = other.labelY + LABEL_HEIGHT;
		}
		placed.push(edge);
	}
	return edges;
}

function buildColumns(nodes, usable, connected) {
	const outer = new Set(nodes.filter((node) => node.ghost || node.self).map((node) => node.id));
	const inner = nodes.filter((node) => connected.has(node.id) && !outer.has(node.id)).map((node) => node.id);
	const ranks = assignRanks(inner, usable.filter((edge) => !outer.has(edge.from) && !outer.has(edge.to)));
	const columns = [];
	for (const id of inner) (columns[ranks.get(id)] ??= []).push(id);
	const receives = new Set(usable.map((edge) => edge.to));
	const around = nodes.filter((node) => outer.has(node.id) && connected.has(node.id)).map((node) => node.id);
	const before = around.filter((id) => !receives.has(id));
	const after = around.filter((id) => receives.has(id));
	return [before, ...columns.filter(Boolean), after].filter((column) => column.length);
}

export function layoutGraph(nodes, edges) {
	const known = new Set(nodes.map((node) => node.id));
	const usable = edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
	const connected = new Set(usable.flatMap((edge) => [edge.from, edge.to]));
	const dense = buildColumns(nodes, usable, connected);
	orderColumns(dense, usable);
	const gapX = dense.length <= 3 ? 150 : dense.length === 4 ? 130 : 96;
	const tallest = Math.max(0, ...dense.map((column) => column.length));
	const graphHeight = tallest ? tallest * NODE_HEIGHT + (tallest - 1) * GAP_Y : 0;
	const placed = new Map();
	dense.forEach((column, columnIndex) => {
		const height = column.length * NODE_HEIGHT + (column.length - 1) * GAP_Y;
		column.forEach((id, index) => placed.set(id, { x: columnIndex * (NODE_WIDTH + gapX), y: (graphHeight - height) / 2 + index * (NODE_HEIGHT + GAP_Y) }));
	});
	const graphWidth = dense.length ? dense.length * NODE_WIDTH + (dense.length - 1) * gapX : 0;
	const loose = nodes.filter((node) => !connected.has(node.id));
	const perRow = Math.max(graphWidth ? Math.floor((graphWidth + GRID_GAP_X) / (NODE_WIDTH + GRID_GAP_X)) : Math.ceil(Math.sqrt(loose.length * 2)), 1);
	const gridTop = graphHeight ? graphHeight + 64 : 0;
	loose.forEach((node, index) => placed.set(node.id, { x: (index % perRow) * (NODE_WIDTH + GRID_GAP_X), y: gridTop + Math.floor(index / perRow) * (NODE_HEIGHT + GAP_Y) }));
	const offsets = assignPorts(usable, placed);
	const rows = Math.ceil(loose.length / perRow);
	return {
		nodes: nodes.map((node) => ({ ...node, ...placed.get(node.id), width: NODE_WIDTH, height: NODE_HEIGHT })),
		edges: separateLabels(usable.map((edge) => routeEdge(edge, placed.get(edge.from), placed.get(edge.to), offsets))),
		width: Math.max(graphWidth + (dense.length ? 60 : 0), loose.length ? Math.min(perRow, loose.length) * (NODE_WIDTH + GRID_GAP_X) - GRID_GAP_X : 0),
		height: rows ? gridTop + rows * (NODE_HEIGHT + GAP_Y) - GAP_Y : graphHeight + 40,
	};
}
