import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB_SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));

export function buildId() {
	const hash = createHash("sha1");
	for (const name of readdirSync(HUB_SOURCE_DIR).filter((f) => f.endsWith(".mjs")).sort()) {
		hash.update(name);
		hash.update(readFileSync(join(HUB_SOURCE_DIR, name)));
	}
	return hash.digest("hex").slice(0, 12);
}
