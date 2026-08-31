/**
 * Integration edge cases — scenarios 13..24 from the merge spec plus the
 * ownership-marker and standalone-pi-retry-warning contracts.
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
	respondBackgroundTasks,
} = jiti("../harness.cjs");
const { BACKGROUND_TIMEOUT_WAKE_CONTENT } = jiti(
	"../../src/lifecycle/goal-controller.ts",
);

const RETRY_TRIGGER = "pi-goal:retry-trigger";
const GOAL_EVENT = "pi-goal-event";
const CONTINUATION_MARKER = "Continue working toward the active thread goal.";

async function setup(opts = {}) {
	process.env.PI_GOAL_RETRY_BASE_DELAY_MS = "5";
	process.env.PI_GOAL_RETRY_MAX_DELAY_MS = "40";
	process.env.PI_GOAL_BG_QUERY_TIMEOUT_MS = "15";
	process.env.PI_GOAL_BG_WAKE_GRACE_MS = "20";
	process.env.PI_GOAL_BG_WAIT_TIMEOUT_MS = String(opts.waitTimeoutMs ?? 150);
	process.env.PI_GOAL_BG_PROBE_RETRY_DELAY_MS = "10";
	const mod = await loadExtension();
	const harness = createFakePi();
	if (opts.bgTasks) respondBackgroundTasks(harness, opts.bgTasks);
	mod.default(harness.api);
	await flush(60);
	return harness;
}

const retryTriggers = (h) => h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length;
const goalContinuations = (h) => h.state.sent.filter((m) => m.customType === GOAL_EVENT && m.content?.includes(CONTINUATION_MARKER)).length;

async function createGoal(harness, objective = "ship the release") {
	const tool = harness.state.tools.get("create_goal");
	await tool.execute("t1", { objective }, undefined, undefined, harness.makeCtx());
	harness.state.sent.length = 0;
}

async function completeGoal(harness) {
	const tool = harness.state.tools.get("update_goal");
	return tool.execute("t2", { status: "complete" }, undefined, undefined, harness.makeCtx());
}

async function runCommand(harness, name, args) {
	const cmd = harness.state.commands.get(name);
	await cmd.handler(args, harness.makeCtx());
}

// ── 13 ── provider status query fails → unknown → no premature continuation
test("13. failing status queries fail closed and never continue prematurely", async () => {
	let calls = 0;
	const h = await setup({
		waitTimeoutMs: 10_000, // keep the timeout out of the way for this test
		bgTasks: (request) => {
			if (request.operation === "status") calls++;
			return [{ id: "t1", status: "running" }];
		},
	});
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(80);
	assert.equal(goalContinuations(h), 0); // waiting, not continuing
	assert.ok(calls >= 1);

	// Recovery only when the provider confirms idle.
	h.state.sessionEntries.length = 0;
});

// ── 14 ── background timeout wakes the agent to investigate; nothing is killed/marked complete
test("14. wait timeout sends one investigation wake and re-arms without declaring completion", async () => {
	let killRequests = 0;
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({
		waitTimeoutMs: 60,
		bgTasks: (request) => {
			if (request.operation === "kill") killRequests++;
			return tasks;
		},
	});
	await createGoal(h);
	await simulateRun(h, assistantMessage());

	// Timeout fires once per epoch → exactly one investigation wake.
	await flush(220);
	assert.equal(h.state.sent.filter((m) => m.content === BACKGROUND_TIMEOUT_WAKE_CONTENT).length, 1);
	assert.equal(killRequests, 0); // timeout never kills work
	// The task snapshot still reports running — we never marked it complete.
	tasks = [];
	await flush(50);
});

// Regression for the re-arm deadlock: after a timeout wake, if the agent stops
// again with the SAME busy id-set, a fresh inactivity timer must exist.
test("14b. timeout timer is re-armed when waiting resumes with an unchanged task set", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ waitTimeoutMs: 60, bgTasks: () => tasks });
	await createGoal(h);
	await simulateRun(h, assistantMessage());

	// First epoch: one wake.
	await flush(220);
	assert.equal(h.state.sent.filter((m) => m.content === BACKGROUND_TIMEOUT_WAKE_CONTENT).length, 1);

	// Agent investigated and stopped normally; background STILL busy (same ids).
	await simulateRun(h, assistantMessage());
	await flush(40);
	assert.equal(
		h.state.sent.filter((m) => m.content === BACKGROUND_TIMEOUT_WAKE_CONTENT).length,
		1,
		"no immediate second wake (once per epoch)",
	);

	// A new full timeout period must produce another fallback wake — this
	// regression-fails if the resumed wait had no live timer.
	await flush(220);
	assert.equal(
		h.state.sent.filter((m) => m.content === BACKGROUND_TIMEOUT_WAKE_CONTENT).length,
		2,
		"re-armed epoch must fire again",
	);
});

// ── 15 ── update_goal(complete) while retry timer pending → retry cancelled
test("15. completing the goal cancels a pending retry and blocks continuation", async () => {
	const h = await setup();
	await createGoal(h);
	const cancelled = [];
	h.bus.on("pi-retry:cancelled", () => cancelled.push(1));

	await simulateRun(h, errorMessage("503 service unavailable"));
	await completeGoal(h); // while the backoff timer is pending
	await flush(40);

	assert.equal(retryTriggers(h), 0); // dropped
	assert.equal(cancelled.length, 1); // lifecycle event fired
	assert.equal(goalContinuations(h), 0);
});

// ── 16 ── update_goal(complete) while background waiting → later terminal event → NO wake
test("16. completed goal ignores later background terminal events", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(goalContinuations(h), 0); // waiting

	await completeGoal(h);
	h.state.sent.length = 0;
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "t1", status: "completed" } });
	await flush(120);
	assert.equal(goalContinuations(h), 0); // nothing may revive a completed goal
});

// ── 17 ── /goal pause while background running → completion → NO wake
test("17. paused goal stays silent when background work completes", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);

	await runCommand(h, "goal", "pause");
	h.state.sent.length = 0;
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "t1", status: "completed" } });
	await flush(120);
	assert.equal(goalContinuations(h), 0);
});

// ── 18 ── /goal clear while retry pending → NO retry/continuation
test("18. clearing the goal kills a pending retry", async () => {
	const h = await setup();
	await createGoal(h);
	await simulateRun(h, errorMessage("connection error"));
	await runCommand(h, "goal", "clear"); // before the backoff fires
	h.state.sent.length = 0;
	await flush(40);
	assert.equal(retryTriggers(h), 0);
	assert.equal(goalContinuations(h), 0);
});

// ── 19 ── user Esc/abort during retry delay → retry does not revive Agent
test("19. abort during the backoff window prevents the retry turn", async () => {
	const h = await setup();
	await simulateRun(h, errorMessage("503 service unavailable")); // schedules retry in ~5ms
	// Esc produces an aborted assistant message, not an error-shaped one.
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "aborted", content: [] } });
	await flush(40);
	assert.equal(retryTriggers(h), 0);

	// Fresh input clears the flag; recovery works again afterwards.
	await h.fire("input", { text: "hello", source: "interactive" });
	assert.equal(retryTriggers(h), 0);
});

// ── 20 ── user message wins over a pending goal continuation (no duplicate turn)
test("20. user input during the background grace window cancels the fallback wake", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);

	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "t1", status: "completed" } });
	// User types during the wake-grace debounce.
	await h.fire("input", { text: "actually, do something else", source: "interactive" });
	await flush(120);
	assert.equal(goalContinuations(h), 0); // the automatic wake was invalidated
});

// ── 21 ── background terminal + provider error race → at most one autonomous next turn
test("21. terminal event racing a scheduled retry yields exactly one autonomous turn", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h);

	await simulateRun(h, errorMessage("503 service unavailable")); // retry scheduled (priority 50)
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "t1", status: "completed" } });
	await flush(150);

	// The retry owns the next turn; the background wake must NOT stack on top.
	assert.equal(retryTriggers(h), 1);
	assert.equal(goalContinuations(h), 0);

	// Retry succeeds → settle → exactly one goal continuation.
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(retryTriggers(h), 1);
	assert.equal(goalContinuations(h), 1);
});

// ── 22 ── stale callback from previous goal generation ignored
test("22. replacing the goal invalidates callbacks from the old generation", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h, "old objective");
	await simulateRun(h, assistantMessage());
	await flush(60);

	// Terminal arrives → grace timer armed for the OLD goal…
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "t1", status: "completed" } });
	// …but the user replaces the goal during the grace window.
	await createGoal(h, "new objective");
	await flush(150);

	assert.equal(goalContinuations(h), 0); // stale wake never fires
	// The new goal continues normally on its own settle cycle.
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(goalContinuations(h), 1);
});

// ── 23 ── session reload preserves pi-goal semantics; no stale retry survives
test("23. reload pauses an active goal and drops stale retry timers", async () => {
	const h = await setup();
	await createGoal(h);
	await simulateRun(h, errorMessage("503 service unavailable"));

	// Reload with the same session entries (goal restored, then paused).
	await h.fire("session_start", { type: "session_start", reason: "reload" });
	const lastEntry = h.state.entries[h.state.entries.length - 1];
	assert.equal(lastEntry.data.goal.status, "paused");

	h.state.sent.length = 0;
	await flush(40);
	assert.equal(retryTriggers(h), 0);
	assert.equal(goalContinuations(h), 0);
});

// ── 24 ── standalone non-Goal mode keeps pi-retry behavior equivalent
test("24a. non-goal mode retries indefinitely until success (pi-retry parity)", async () => {
	const h = await setup();
	// Backoff grows per attempt (5/10/20/40ms under test env); wait each one out.
	const waits = [20, 30, 50, 120];
	for (let i = 0; i < 4; i++) {
		await simulateRun(h, errorMessage(i % 2 ? "ECONNRESET" : "fetch failed"));
		await flush(waits[i]);
	}
	assert.equal(retryTriggers(h), 4);

	await simulateRun(h, assistantMessage());
	await flush(30);
	assert.equal(retryTriggers(h), 4); // success stops the loop
	assert.equal(goalContinuations(h), 0);
});

test("24b. non-goal mode: length continues are uncapped, empty nudges capped at one", async () => {
	const h = await setup();
	// Two consecutive length stops → two continuations (uncapped).
	await simulateRun(h, { role: "assistant", stopReason: "length", content: [] });
	await flush(20);
	await simulateRun(h, { role: "assistant", stopReason: "length", content: [] });
	await flush(20);
	assert.equal(h.state.sent.filter((m) => m.content.includes("Continue exactly where you left off")).length, 2);

	// Empty stop → one nudge; second empty stop gives up with a warning.
	await simulateRun(h, { role: "assistant", stopReason: "stop", content: [] });
	await flush(20);
	assert.equal(h.state.sent.filter((m) => m.content.includes("only thinking and no answer")).length, 1);
	await simulateRun(h, { role: "assistant", stopReason: "stop", content: [] });
	await flush(20);
	assert.equal(h.state.sent.filter((m) => m.content.includes("only thinking and no answer")).length, 1); // no second nudge
	assert.ok(h.state.notifications.some((n) => n.text.includes("giving up")));

	// A usable turn restores the nudge budget.
	await simulateRun(h, assistantMessage());
	await flush(20);
	await simulateRun(h, { role: "assistant", stopReason: "stop", content: [] });
	await flush(20);
	assert.equal(h.state.sent.filter((m) => m.content.includes("only thinking and no answer")).length, 2);
});

test("24c. non-goal mode: permanent and quota errors halt with notifications, no retry loop", async () => {
	const h = await setup();
	await simulateRun(h, errorMessage("Invalid API key provided"));
	await flush(30);
	assert.equal(retryTriggers(h), 0);
	assert.ok(h.state.notifications.some((n) => n.text.includes("Non-retryable error")));
	assert.ok(!h.state.notifications.some((n) => n.text.includes("auto-paused"))); // no goal → no pause

	await simulateRun(h, errorMessage("You've hit your usage limit · resets 4pm"));
	await flush(30);
	assert.equal(retryTriggers(h), 0);
	assert.ok(h.state.notifications.some((n) => n.text.includes("Quota/limit exhausted")));
});

test("24d. manual /retry works after abort suppression and reports diagnostics", async () => {
	const h = await setup();
	await simulateRun(h, errorMessage("503 service unavailable"));
	// Esc → aborted assistant message sets the sticky abort flag.
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "aborted", content: [] } });
	await flush(20);
	assert.equal(retryTriggers(h), 0);

	// Manual /retry overrides the abort flag explicitly.
	await runCommand(h, "retry", "");
	await flush(20);
	assert.equal(retryTriggers(h), 1);

	// /retry reset clears counters; /retry status renders diagnostics.
	await runCommand(h, "retry", "reset");
	await runCommand(h, "retry", "status");
	const statusNotice = h.state.notifications.at(-1)?.text ?? "";
	assert.match(statusNotice, /Retry Status \(built into pi-goal\)/);
	assert.match(statusNotice, /Coordinator phase/);
});

// Matrix supplement: goal active + empty stop → nudge once, no goal continuation
test("goal active + empty stop nudges once and does not continue the goal into emptiness", async () => {
	const h = await setup();
	await createGoal(h);

	await simulateRun(h, { role: "assistant", stopReason: "stop", content: [] });
	await flush(30);
	assert.equal(h.state.sent.filter((m) => m.content.includes("only thinking and no answer")).length, 1);
	assert.equal(goalContinuations(h), 0); // no continuation stacked on the nudge

	// Model answers the nudge with usable output → goal resumes normally.
	await simulateRun(h, assistantMessage());
	await flush(30);
	assert.equal(goalContinuations(h), 1);
});

// Matrix supplement: goal active + permanent error → halt loop, notify, auto-pause
test("goal active + permanent error pauses the goal instead of looping", async () => {
	const h = await setup();
	await createGoal(h);

	await simulateRun(h, errorMessage("model not found: gpt-9"));
	await flush(30);

	assert.equal(retryTriggers(h), 0); // never retried
	assert.equal(goalContinuations(h), 0); // never continued
	const lastEntry = h.state.entries.at(-1)?.data?.goal;
	assert.equal(lastEntry?.status, "paused"); // auto-paused, not silently looping
	assert.ok(h.state.notifications.some((n) => n.text.includes("auto-paused")));
	assert.ok(h.state.notifications.some((n) => n.text.includes("Non-retryable error")));
});

// ── ownership marker exists and standalone pi-retry activity triggers a single warning
test("ownership marker exists and standalone pi-retry activity triggers a single warning", async () => {
	const h = await setup();
	assert.equal(typeof (globalThis[Symbol.for("pi-goal.retry-owner.v1")] ?? {}).version, "number");

	// A standalone pi-retry emitting its public lifecycle event triggers a warning once.
	await h.fire("session_start", { type: "session_start", reason: "startup" }); // capture ctx for notify()
	externalEmit(h, "pi-retry:started", { retryId: 999 });
	externalEmit(h, "pi-retry:started", { retryId: 1000 });
	const warnings = h.state.notifications.filter((n) => n.text.includes("Standalone pi-retry"));
	assert.equal(warnings.length, 1);
});

function externalEmit(harness, channel, data) {
	harness.state.busListeners.get(channel)?.forEach((fn) => fn(data));
}
