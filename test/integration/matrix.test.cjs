/**
 * Integration matrix tests — scenarios 1..12 from the merge spec, driven
 * through the fake ExtensionAPI harness (no real model).
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
	lengthMessage,
	emptyStopMessage,
	simulateRun,
	flush,
	respondBackgroundTasks,
	respondSubagents,
} = jiti("../harness.cjs");

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
	if (opts.subagents) respondSubagents(harness, opts.subagents);
	mod.default(harness.api);
	await flush(60); // eager presence probes settle
	return harness;
}

function countSent(harness, predicate) {
	return harness.state.sent.filter(predicate).length;
}

const retryTriggers = (h) => countSent(h, (m) => m.customType === RETRY_TRIGGER);
const goalContinuations = (h) => countSent(h, (m) => m.customType === GOAL_EVENT && m.content?.includes(CONTINUATION_MARKER));

async function createGoal(harness, objective = "ship the release") {
	const tool = harness.state.tools.get("create_goal");
	const result = await tool.execute("t1", { objective }, undefined, undefined, harness.makeCtx());
	harness.state.sent.length = 0; // clear the initial activation event
	return result;
}

async function completeGoal(harness) {
	const tool = harness.state.tools.get("update_goal");
	return tool.execute("t2", { status: "complete" }, undefined, undefined, harness.makeCtx());
}

// ── 1 ── no goal + 503 → retry → success → no additional turn
test("1. no goal + 503 retries once and never adds a goal turn", async () => {
	const h = await setup();
	const lifecycleEvents = [];
	h.bus.on("pi-retry:started", () => lifecycleEvents.push("started"));
	h.bus.on("pi-retry:completed", () => lifecycleEvents.push("completed"));

	await simulateRun(h, errorMessage("503 service unavailable"));
	await flush(30);
	assert.equal(retryTriggers(h), 1);
	assert.equal(goalContinuations(h), 0);

	await simulateRun(h, assistantMessage());
	await flush(30);
	assert.equal(retryTriggers(h), 1); // still exactly one retry turn
	assert.equal(goalContinuations(h), 0); // no goal → no continuation ever
	assert.deepEqual(lifecycleEvents, ["started", "completed"]);
});

// ── 2 ── active goal + 503 → exactly one retry, no simultaneous goal continuation
test("2. active goal + 503 → retry only; continuation only after retry settles", async () => {
	const h = await setup({ bgTasks: () => [] });
	await createGoal(h);

	await simulateRun(h, errorMessage("503 service unavailable"));
	await flush(30);
	assert.equal(retryTriggers(h), 1);
	assert.equal(goalContinuations(h), 0); // no double wake while retry owns the turn

	await simulateRun(h, assistantMessage());
	await flush(30);
	assert.equal(retryTriggers(h), 1);
	assert.equal(goalContinuations(h), 1); // exactly one continuation after recovery settles
});

// ── 3 ── repeated network errors: backoff grows, no goal continuation during retries
test("3. active goal + repeated network errors back off without goal continuations", async () => {
	const h = await setup();
	await createGoal(h);

	await simulateRun(h, errorMessage("connection error"));
	await flush(10);
	await simulateRun(h, errorMessage("ECONNRESET"));
	await flush(15);
	await simulateRun(h, errorMessage("connection error"));
	await flush(40);

	assert.equal(retryTriggers(h), 3);
	assert.equal(goalContinuations(h), 0);
	// Backoff attempts surfaced to the user in order.
	const lastAttemptNotice = [...h.state.notifications].reverse().find((n) => /retry attempt \d/.test(n.text));
	assert.ok(lastAttemptNotice, "expected a retry attempt notice");
	assert.match(lastAttemptNotice.text, /retry attempt 3/);

	await simulateRun(h, assistantMessage());
	await flush(30);
	assert.equal(goalContinuations(h), 1); // resumes only after full settle
});

// ── 4 ── active goal + length → exactly one max-token continuation path
test("4. active goal + length stop continues exactly once per stop, then goal resumes", async () => {
	const h = await setup();
	await createGoal(h);

	await simulateRun(h, lengthMessage());
	await flush(30);
	assert.equal(countSent(h, (m) => m.customType === RETRY_TRIGGER && m.content.includes("Continue exactly where you left off")), 1);
	assert.equal(goalContinuations(h), 0);

	await simulateRun(h, assistantMessage());
	await flush(30);
	assert.equal(goalContinuations(h), 1); // single goal continuation, not a duplicate
});

// ── 5 ── active goal + normal stop + no background → goal continuation
test("5. active goal + normal stop without background work continues the goal", async () => {
	const h = await setup();
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(40);
	assert.equal(goalContinuations(h), 1);
});

// ── 6 ── active goal + normal stop + pi-background-tasks running → WAIT, no continuation
test("6. normal stop with a running background task waits instead of continuing", async () => {
	let tasks = [{ id: "cargo-1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h);

	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(goalContinuations(h), 0); // WAITING_FOR_BACKGROUND

	// Background finishes but nobody re-wakes us yet — still no continuation.
	tasks = [];
	await flush(40);
	assert.equal(goalContinuations(h), 0);
});

// ── 7 ── final task completes with its own wake pending → no duplicate Goal wake
test("7. background terminal with plugin-owned pending wake does not duplicate", async () => {
	let tasks = [{ id: "cargo-1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(goalContinuations(h), 0);

	// The plugin delivers its own follow-up wake (pending messages)…
	h.state.pendingMessages = true;
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "cargo-1", status: "completed" } });
	await flush(80);
	assert.equal(goalContinuations(h), 0); // …so pi-goal stays silent

	h.state.pendingMessages = false;
});

// ── 8 ── final task completes WITHOUT auto wake → Goal performs one fallback wake
test("8. silent background completion triggers exactly one fallback goal continuation", async () => {
	let tasks = [{ id: "cargo-1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);

	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "cargo-1", status: "completed" } });
	await flush(100);
	assert.equal(goalContinuations(h), 1); // fallback wake, exactly once
});

// ── 9 ── active goal + pi-subagents async run → normal stop waits
test("9. normal stop with an active subagent run waits", async () => {
	const h = await setup({ subagents: { fleet: { totalActive: 1, entries: [{ key: "k1" }] } } });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(goalContinuations(h), 0);
});

// ── 10 ── multiple subagents: A completes, B running → still waits
test("10. one of two subagents completing is not enough to resume", async () => {
	let totalActive = 2;
	const h = await setup({ subagents: () => ({ fleet: { totalActive, entries: [] } }) });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(goalContinuations(h), 0);

	totalActive = 1; // reviewer A done…
	h.bus.emit("subagent:async-complete", { asyncId: "a" });
	await flush(80);
	assert.equal(goalContinuations(h), 0); // …but B still runs
});

// ── 11 ── A + B all complete → resume exactly once
test("11. all subagents settled resumes the goal exactly once", async () => {
	let totalActive = 2;
	const h = await setup({ subagents: () => ({ fleet: { totalActive, entries: [] } }) });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);

	totalActive = 1;
	h.bus.emit("subagent:async-complete", {});
	await flush(60);
	totalActive = 0;
	h.bus.emit("subagent:async-complete", {});
	h.bus.emit("subagent:process-terminal", {});
	await flush(120);
	assert.equal(goalContinuations(h), 1);
});

// ── 12 ── both background systems at once: all must settle before resuming
test("12. mixed providers resume only when every provider is idle", async () => {
	let tasks = [{ id: "cargo-1", status: "running" }];
	let totalActive = 1;
	const h = await setup({ bgTasks: () => tasks, subagents: () => ({ fleet: { totalActive, entries: [] } }) });
	await createGoal(h);
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(goalContinuations(h), 0);

	// cargo test finishes; reviewer still running.
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "cargo-1", status: "completed" } });
	await flush(90);
	assert.equal(goalContinuations(h), 0);

	// reviewer finishes too.
	totalActive = 0;
	h.bus.emit("subagent:async-complete", {});
	await flush(120);
	assert.equal(goalContinuations(h), 1); // resumed exactly once
});
