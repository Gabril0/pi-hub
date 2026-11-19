import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp, damp, edgeRates, formatNumber, lerp, sameFormat, splitNumber, zoomAround } from "../web/lib/lerp.js";

test("lerp reaches both ends and clamp holds the range", () => {
	assert.equal(lerp(10, 20, 0), 10);
	assert.equal(lerp(10, 20, 1), 20);
	assert.equal(lerp(10, 20, 0.5), 15);
	assert.equal(clamp(9, 0, 3), 3);
	assert.equal(clamp(-1, 0, 3), 0);
});

test("damping lands in the same place at any frame rate", () => {
	const run = (fps) => {
		let value = 0;
		for (let i = 0; i < fps / 2; i++) value = damp(value, 100, 12, 1 / fps);
		return value;
	};
	assert.ok(Math.abs(run(30) - run(144)) < 1e-9);
	assert.ok(run(60) > 99 && run(60) < 100);
});

test("the leading edge of a glider moves faster than the trailing one", () => {
	assert.deepEqual(edgeRates(10, 24, 12), { start: 12, end: 24 });
	assert.deepEqual(edgeRates(-10, 24, 12), { start: 24, end: 12 });
});

test("zooming around a point keeps that point still", () => {
	const camera = { k: 2, x: 30, y: -10 };
	const next = zoomAround(camera, 1.7, 200, 90);
	const world = { x: (200 - camera.x) / camera.k, y: (90 - camera.y) / camera.k };
	assert.ok(Math.abs(world.x * next.k + next.x - 200) < 1e-9);
	assert.ok(Math.abs(world.y * next.k + next.y - 90) < 1e-9);
});

test("numbers inside labels can be tweened and printed back exactly", () => {
	for (const text of ["12", "$0.12", "1.2k", "87%", "340ms", "1,204", "-3"]) assert.equal(formatNumber(splitNumber(text), splitNumber(text).value), text);
	assert.equal(formatNumber(splitNumber("1,204"), 1250000), "1,250,000");
	assert.equal(splitNumber("4m 3s"), null);
	assert.equal(splitNumber("live"), null);
	assert.ok(sameFormat(splitNumber("$1.20"), splitNumber("$9.75")));
	assert.ok(!sameFormat(splitNumber("12ms"), splitNumber("1.2s")));
});
