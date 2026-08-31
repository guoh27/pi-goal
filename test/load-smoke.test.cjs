// Smoke test: the extension entry must load through jiti (same loader pi uses).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

test("extension entry loads and exports a factory function", async () => {
	const { loadExtension } = await import("./harness.cjs");
	const mod = await loadExtension();
	assert.equal(typeof mod.default, "function");
});
