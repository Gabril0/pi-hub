export const PALETTE = [
	{ name: "iris", hex: "#9b8ff0" },
	{ name: "pistachio", hex: "#b4e68f" },
	{ name: "coral", hex: "#f19e98" },
	{ name: "steel", hex: "#47aec6" },
	{ name: "sand", hex: "#edcaa8" },
	{ name: "orchid", hex: "#d879b7" },
	{ name: "periwinkle", hex: "#a9b6e2" },
	{ name: "tan", hex: "#b39a74" },
	{ name: "blossom", hex: "#f5b5df" },
	{ name: "sage", hex: "#a1c2a0" },
];

const PALETTE_NAMES = new Set(PALETTE.map((c) => c.name));

export function pickColor(sessions, sessionId) {
	const existing = sessions.find((s) => s.id === sessionId)?.color;
	if (existing && PALETTE_NAMES.has(existing.name)) return existing;
	const inUse = new Map();
	for (const session of sessions) {
		if (!session.color || session.id === sessionId) continue;
		const weight = session.online ? 10 : 1;
		inUse.set(session.color.name, (inUse.get(session.color.name) ?? 0) + weight);
	}
	let best = PALETTE[0];
	let bestScore = Number.POSITIVE_INFINITY;
	for (const color of PALETTE) {
		const score = inUse.get(color.name) ?? 0;
		if (score < bestScore) {
			best = color;
			bestScore = score;
		}
	}
	return best;
}
