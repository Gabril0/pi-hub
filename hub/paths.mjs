import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function canonicalPath(path) {
	const absolute = resolve(String(path ?? ""));
	const missing = [];
	for (let current = absolute; ; current = dirname(current)) {
		try {
			return join(realpathSync.native(current), ...missing);
		} catch {
			if (dirname(current) === current) return absolute;
			missing.unshift(basename(current));
		}
	}
}
