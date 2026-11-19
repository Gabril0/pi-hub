export function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

export function lerp(from, to, amount) {
	return from + (to - from) * amount;
}

export function damp(from, to, rate, seconds) {
	return lerp(from, to, 1 - Math.exp(-rate * seconds));
}

export function edgeRates(moved, lead = 24, trail = 12) {
	return moved >= 0 ? { start: trail, end: lead } : { start: lead, end: trail };
}

export function zoomAround(camera, scale, x, y) {
	return { k: camera.k * scale, x: x - (x - camera.x) * scale, y: y - (y - camera.y) * scale };
}

export function splitNumber(text) {
	const match = /^([^\d-]*)(-?\d[\d,]*)(\.\d+)?(\D*)$/.exec(String(text));
	if (!match) return null;
	const [, prefix, whole, fraction = "", suffix] = match;
	return { prefix, suffix, value: Number(`${whole.replaceAll(",", "")}${fraction}`), decimals: Math.max(0, fraction.length - 1), grouped: whole.includes(",") };
}

export function formatNumber(parts, value) {
	const fixed = value.toFixed(parts.decimals);
	if (!parts.grouped) return `${parts.prefix}${fixed}${parts.suffix}`;
	const [whole, fraction] = fixed.split(".");
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${parts.prefix}${grouped}${fraction ? `.${fraction}` : ""}${parts.suffix}`;
}

export function sameFormat(a, b) {
	return Boolean(a && b && a.prefix === b.prefix && a.suffix === b.suffix && a.decimals === b.decimals);
}
