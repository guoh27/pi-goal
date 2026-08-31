/**
 * Regression test for the real-world bug from the merge spec (section 21):
 *
 *   goal active
 *     → work
 *     → provider 503
 *     → retry
 *     → update_goal({ status: "complete" })
 *     → another provider/network lifecycle event occurs
 *     → coordinator settles
 *
 * Assert: goal.status === complete, and afterwards there is NEVER another
 * "Continue working toward the active thread goal." nor a pi-retry-triggered
 * retry belonging to the invalidated generation.
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
	process.env.PI_GOAL_RETRY_BASE_DELAY_MS = "5";
	process.env.PI_GOAL_RETRY_MAX_DELAY_MS = "40";
	process.env.PI_GOAL_BG_QUERY_TIMEOUT_MS = "15";
	process.env.PI_GOAL_BG_WAKE_GRACE_MS = "20";
	process.env.PI_GOAL_BG_WAIT_TIMEOUT_MS = "150";
	process.env.PI_GOAL_BG_PROBE_RETRY_DELAY_MS = "10";
	const mod = await loadExtension();
	const harness = createFakePi();
	mod.default(harness.api);
	await flush(60);
	return harness;
}

test("regression: completing the goal mid-lifecycle permanently silences goal continuation", async () => {
	const h = await setup();

	// 1. goal active
	const tool = h.state.tools.get("create_goal");
	await tool.execute("t1", { objective: "finish the audit" }, undefined, undefined, h.makeCtx());
	h.state.sent.length = 0;

	// 2. work (a successful run)
	await simulateRun(h, assistantMessage());
	await flush(30);
	assert.equal(goalContinuations(h), 1); // goal loop working normally

	// 3. provider 503 → 4. retry fires and recovers
	await simulateRun(h, errorMessage("503 service unavailable"));
	await flush(30);
	assert.equal(retryTriggersTotal(h), 1);

	// The retry turn succeeds.
	await simulateRun(h, assistantMessage());
	await flush(30);

	// 5. model marks the goal complete mid-session.
	const updateTool = h.state.tools.get("update_goal");
	await updateTool.execute("t9", { status: "complete" }, undefined, undefined, h.makeCtx());
	const persisted = h.state.entries.at(-1)?.data?.goal;
	assert.equal(persisted?.status, "complete");

	// Snapshot everything sent up to completion; nothing new may appear after.
	h.state.sent.length = 0;

	// 6. another provider/network lifecycle event occurs…
	await simulateRun(h, errorMessage("connection error"));
	await flush(40);
	await simulateRun(h, errorMessage("ECONNRESET"));
	await flush(60);

	// …and 7. the coordinator settles (agent_settled fired inside simulateRun).
	// Assertions: no continuation prompt, no retries from the dead generation.
	assert.equal(goalContinuations(h), 0, "no 'Continue working…' may follow completion");
	assert.equal(retryTriggersTotal(h), 0, "no retry may belong to the invalidated generation");
	assert.equal(
		h.state.sent.filter((m) => m.content === CONTINUATION_MARKER || String(m.content).includes(CONTINUATION_MARKER)).length,
		0,
	);

	// Even a background terminal event afterwards must not revive it.
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "x", status: "completed" } });
	await flush(80);
	assert.equal(goalContinuations(h), 0);

	function goalContinuations(harness) {
		return harness.state.sent.filter((m) => m.customType === GOAL_EVENT && String(m.content).includes(CONTINUATION_MARKER)).length;
	}
	function retryTriggersTotal(harness) {
		return harness.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length;
	}
});
