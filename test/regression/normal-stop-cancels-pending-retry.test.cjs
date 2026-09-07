/**
 * Regression: when a run settles with a NORMAL assistant stop, no stale
 * recovery turn ("Retry the previous request.") may still fire afterwards.
 *
 * Real-world trigger: a run fails with a retryable error, the merged engine
 * arms a backoff retry, and pi-core's compaction continues the SAME agent
 * cycle; that continued run ends normally. The stale retry timer from the
 * earlier failure must be cancelled — retrying the previous request after a
 * genuinely completed answer replays a dead request on top of good state.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	createFakePi,
	loadExtension,
	assistantMessage,
	errorMessage,
	simulateRun,
	flush,
} = jiti("../harness.cjs");

const RETRY_TRIGGER = "pi-goal:retry-trigger";
const GOAL_EVENT = "pi-goal-event";
const CONTINUATION_MARKER = "Continue working toward the active thread goal.";

async function setup() {
	// Generous backoff (200ms) so the pending retry CANNOT fire inside the
	// synchronous simulateRun calls — only a bug would let it fire later.
	process.env.PI_GOAL_RETRY_BASE_DELAY_MS = "200";
	process.env.PI_GOAL_RETRY_MAX_DELAY_MS = "800";
	process.env.PI_GOAL_BG_QUERY_TIMEOUT_MS = "15";
	process.env.PI_GOAL_BG_WAKE_GRACE_MS = "20";
	process.env.PI_GOAL_BG_WAIT_TIMEOUT_MS = "150";
	process.env.PI_GOAL_BG_PROBE_RETRY_DELAY_MS = "10";
	const mod = await loadExtension();
	const harness = createFakePi();
	mod.default(harness.api);
	await flush(60); // eager presence probes settle
	return harness;
}

async function createGoal(harness, objective = "ship the release") {
	const tool = harness.state.tools.get("create_goal");
	const result = await tool.execute("t1", { objective }, undefined, undefined, harness.makeCtx());
	harness.state.sent.length = 0; // clear the initial activation event
	return result;
}

const retryTriggers = (h) => h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length;
const goalContinuations = (h) => h.state.sent.filter((m) => m.customType === GOAL_EVENT && m.content?.includes(CONTINUATION_MARKER)).length;

test("normal stop right after an error cancels the pending retry (goal active)", async () => {
	const h = await setup();
	await createGoal(h);
	const lifecycleEvents = [];
	h.bus.on("pi-retry:started", () => lifecycleEvents.push("started"));
	h.bus.on("pi-retry:completed", () => lifecycleEvents.push("completed"));
	h.bus.on("pi-retry:cancelled", () => lifecycleEvents.push("cancelled"));

	// Run 1 fails → engine arms a backoff retry (200ms).
	await simulateRun(h, errorMessage("503 service unavailable"));
	assert.equal(retryTriggers(h), 0, "retry must not have fired yet (backoff pending)");

	// Run 2 ends NORMALLY before the retry timer fires (compaction-continue
	// style) → the pending recovery belongs to a dead failure and must die.
	await simulateRun(h, assistantMessage());
	await flush(600); // far beyond the 200ms backoff — nothing may fire

	assert.equal(retryTriggers(h), 0, "no stale retry may fire after a normal stop");
	// The normal stop legitimately continues the goal exactly once instead.
	assert.equal(goalContinuations(h), 1);
	assert.deepEqual(lifecycleEvents, ["started", "cancelled"], "lifecycle closes cancelled, never completed");
});

test("normal stop cancels pending retry also without a goal (pure session)", async () => {
	const h = await setup();

	await simulateRun(h, errorMessage("connection error"));
	await simulateRun(h, assistantMessage());
	await flush(600);

	assert.equal(retryTriggers(h), 0, "pure sessions must not retry after a normal stop either");
	assert.equal(goalContinuations(h), 0);
});
