const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
const coordinatorSource = readFileSync(
	join(__dirname, "../src/lifecycle/continuation-coordinator.ts"),
	"utf8",
);

test("persisting a non-active goal invalidates the single autonomous owner", () => {
	// persist() must route every goal-state change through invalidateAutonomous,
	// which cancels pending retries/continuations/wakes via the coordinator.
	assert.match(
		indexSource,
		/if \(next == null \|\| next\.status !== "active"\) \{\s*invalidateAutonomous\(next == null \? "goal-cleared" : `goal-\$\{next.status\}`\);\s*\}/,
	);
});

test("invalidation bumps the coordinator generation so no stale callback can fire", () => {
	// invalidateAll clears any pending action AND advances the epoch; timers
	// re-check generation at fire time before executing.
	assert.match(coordinatorSource, /invalidateAll\(why: string\): number/);
	assert.match(coordinatorSource, /this\.generation\+\+/);
	assert.match(coordinatorSource, /action\.generation !== this\.generation/);
});
