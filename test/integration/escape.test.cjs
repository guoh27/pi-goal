/**
 * Esc must cancel pending recovery turns even when NO run is active —
 * the backoff window is idle, so turn_end-based abort detection never fires.
 * Regression test for the real-world "manual stop has no effect, it keeps
 * retrying" report; mirrors upstream pi-retry's onTerminalInput hook.
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
	simulateRun,
	flush,
	respondBackgroundTasks,
} = jiti("../harness.cjs");

const RETRY_TRIGGER = "pi-goal:retry-trigger";
const GOAL_EVENT = "pi-goal-event";
const CONTINUATION_MARKER = "Continue working toward the active thread goal.";

const { resetLiveAgentSessionForTests } = jiti("../../src/lifecycle/agent-abort-hook.ts");

async function setup(opts = {}) {
	process.env.PI_GOAL_RETRY_BASE_DELAY_MS = "5";
	process.env.PI_GOAL_RETRY_MAX_DELAY_MS = "40";
	process.env.PI_GOAL_BG_QUERY_TIMEOUT_MS = "15";
	process.env.PI_GOAL_BG_WAKE_GRACE_MS = "20";
	process.env.PI_GOAL_BG_WAIT_TIMEOUT_MS = "150";
	process.env.PI_GOAL_BG_PROBE_RETRY_DELAY_MS = "10";
	process.env.PI_GOAL_STOP_RACE_WINDOW_MS = "200";
	const mod = await loadExtension();
	const harness = createFakePi();
	if (opts.bgTasks) respondBackgroundTasks(harness, opts.bgTasks);
	mod.default(harness.api);
	// session_start registers the Escape hook (tui mode).
	await harness.fire("session_start", { type: "session_start", reason: "startup" });
	await flush(60);
	return harness;
}

test("Escape during the idle backoff window cancels the scheduled retry", async () => {
	const h = await setup();
	await simulateRun(h, errorMessage("503 service unavailable")); // retry armed, ~5ms away
	h.pressEscape(); // user hits Esc while nothing is running
	await flush(40);
	assert.equal(h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length, 0);

	// Fresh input clears the abort flag — recovery works again afterwards.
	await h.fire("input", { text: "go on", source: "interactive" });
	await simulateRun(h, errorMessage("503 service unavailable"));
	await flush(40);
	assert.equal(h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length, 1);
});

test("Escape during max-tokens continuation window cancels the continuation", async () => {
	const h = await setup();
	await simulateRun(h, lengthMessage());
	h.pressEscape();
	await flush(30);
	assert.equal(h.state.sent.filter((m) => m.content.includes("Continue exactly where you left off")).length, 0);
});

test("Escape stops pending automatic work; fresh input restores the goal wake chain", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	const tool = h.state.tools.get("create_goal");
	await tool.execute("t1", { objective: "keep going" }, undefined, undefined, h.makeCtx());
	h.state.sent.length = 0;

	await h.fire("input", { text: "hello", source: "interactive" }); // clear flag path
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(h.state.sent.filter((m) => m.customType === GOAL_EVENT && String(m.content).includes(CONTINUATION_MARKER)).length, 0); // waiting

	// Esc marks the process stopped: background completion must NOT wake the
	// goal while the stop is in effect (not a permanent kill — the goal stays
	// active and fresh user input restores the wake chain).
	h.pressEscape();
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "t1", status: "completed" } });
	await flush(100);
	assert.equal(
		h.state.sent.filter((m) => m.customType === GOAL_EVENT && String(m.content).includes(CONTINUATION_MARKER)).length,
		0,
		"no wake while the user stop is in effect",
	);

	// Fresh user input restores the goal chain: its run settles and re-snapshots
	// the (now idle) background, so the goal resumes.
	await h.fire("input", { text: "ok continue", source: "interactive" });
	await simulateRun(h, assistantMessage());
	await flush(80);
	assert.ok(
		h.state.sent.some((m) => m.customType === GOAL_EVENT && String(m.content).includes(CONTINUATION_MARKER)),
		"fresh input should restore the goal loop after the stop",
	);
});

test("Escape mid-run abort still works through turn_end (unchanged behavior)", async () => {
	const h = await setup();
	await simulateRun(h, errorMessage("503 service unavailable"));
	// User Escapes DURING the retry run that follows.
	await flush(20); // retry fires and starts a run
	assert.equal(h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length, 1);
	await h.fire("turn_end", { turnIndex: 1, message: { role: "assistant", stopReason: "aborted", content: [] } });
	await h.fire("agent_settled", {});
	await flush(30);
	// No further retries may be scheduled after the abort.
	const before = h.state.sent.length;
	await simulateRun(h, errorMessage("connection error")).catch(() => {});
	// aborted outcome → handleAgentEnd aborts before scheduling anything new
	await flush(30);
	assert.ok(h.state.sent.length >= before - 1);
});

// Race-window regression: an error-shaped run that ends right after a stop
// signal (Esc) must be treated as aborted — the provider error merely arrived
// around the abort and must never re-schedule a retry.
test("error run finishing inside the stop race window does not revive retries", async () => {
	const h = await setup();
	await simulateRun(h, errorMessage("503 service unavailable"));
	h.pressEscape(); // user stops; pending retry cancelled

	// A provider error surfaces in a run that is finishing around the stop.
	await simulateRun(h, errorMessage("connection error"));
	await flush(60);
	assert.equal(h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length, 0, "no retry may be scheduled after a stop");
	assert.equal(h.state.sent.filter((m) => m.customType === GOAL_EVENT && String(m.content).includes(CONTINUATION_MARKER)).length, 0);

	// Once the race window expires AND the user sends fresh input (which clears
	// the sticky abort flag), a new error retries again.
	await flush(300); // > PI_GOAL_STOP_RACE_WINDOW_MS (200) in the test env
	await h.fire("input", { text: "continue please", source: "interactive" });
	await simulateRun(h, errorMessage("503 service unavailable"));
	await flush(40);
	assert.equal(h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length, 1);
});

// pi-web Stop button integration: AgentSession.abort() during the idle backoff
// window must cancel the pending retry (previously a silent no-op → the retry
// fired anyway and the user saw a new "Retry the previous request.").
test("session.abort() from any UI (pi-web stop) cancels a pending retry", async () => {
	const { AgentSession } = await jiti.import("../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const h = await setup();
	await simulateRun(h, errorMessage("503 service unavailable")); // retry armed ~5ms

	// pi-web Stop button with agent idle in the backoff window.
	const fakeSession = {
		sessionId: h.state.sessionId,
		abortRetry() {},
		abortCompaction() {},
		abortBranchSummary() {},
		agent: { abort() {} },
		async waitForIdle() {},
	};
	await AgentSession.prototype.abort.call(fakeSession);

	await flush(60);
	assert.equal(
		h.state.sent.filter((m) => m.customType === RETRY_TRIGGER).length,
		0,
		"abort during backoff must cancel the pending retry",
	);
	assert.equal(
		h.state.sent.filter((m) => m.customType === GOAL_EVENT && String(m.content).includes(CONTINUATION_MARKER)).length,
		0,
	);
});

// Root-cause regression for "cannot stop: background-task-notification keeps
// waking the agent": the bg plugin's completion notification is sent with
// triggerTurn:true straight through pi's sendCustomMessage, bypassing the
// coordinator. While the user stop is in effect it must be delivered into the
// session WITHOUT starting a run; fresh user input restores triggering.
test("background-task-notification triggerTurn is suppressed while the stop is in effect", async () => {
	const { AgentSession } = await jiti.import("../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const h = await setup();
	let runStarted = 0;
	const fakeSession = {
		sessionId: h.state.sessionId,
		isStreaming: false,
		agent: { state: { messages: [] } },
		sessionManager: { appendCustomMessageEntry() {} },
		_emit() {},
		_runAgentPrompt() {
			runStarted += 1;
		},
	};
	const notification = {
		customType: "background-task-notification",
		content: "<background-task-notification>...</background-task-notification>",
		display: true,
		details: {},
	};

	// No stop: the notification starts a run.
	await AgentSession.prototype.sendCustomMessage.call(fakeSession, notification, {
		deliverAs: "followUp",
		triggerTurn: true,
	});
	assert.equal(runStarted, 1, "without a stop the notification triggers a run");

	// Stop in effect: message still lands in the session, no run starts.
	h.pressEscape();
	runStarted = 0;
	const before = fakeSession.agent.state.messages.length;
	await AgentSession.prototype.sendCustomMessage.call(fakeSession, notification, {
		deliverAs: "followUp",
		triggerTurn: true,
	});
	assert.equal(runStarted, 0, "notification must not start a run while stopped");
	assert.equal(
		fakeSession.agent.state.messages.length,
		before + 1,
		"the notification itself is still recorded in the session",
	);

	// Fresh user input restores triggering.
	await h.fire("input", { text: "go on", source: "interactive" });
	await AgentSession.prototype.sendCustomMessage.call(fakeSession, notification, {
		deliverAs: "followUp",
		triggerTurn: true,
	});
	assert.equal(runStarted, 1, "fresh input restores notification triggering");
});

// Backstop: a turn that starts anyway while the stop is in effect (e.g. a
// followUp notification queued before the stop, drained after the aborted
// run) is aborted at turn_start before any LLM request.
test("turn_start while stopped aborts the autonomous wake turn", async () => {
	let tasks = [{ id: "t1", status: "running" }];
	const h = await setup({ bgTasks: () => tasks });
	const tool = h.state.tools.get("create_goal");
	await tool.execute("t1", { objective: "keep going" }, undefined, undefined, h.makeCtx());
	h.state.sent.length = 0;
	await h.fire("input", { text: "hello", source: "interactive" });
	await simulateRun(h, assistantMessage());
	await flush(60);
	assert.equal(h.state.sent.filter((m) => m.customType === GOAL_EVENT).length, 0); // waiting on background

	h.pressEscape(); // user stops
	// Exercise the ctx.abort() fallback (the live-session capture is set by
	// earlier tests' fake abort calls).
	resetLiveAgentSessionForTests();
	const before = h.state.abortCalls;
	// The bg plugin's triggerTurn wakes the agent anyway (its sendMessage
	// predates the stop): a turn starts and must be aborted immediately.
	await h.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
	assert.ok(h.state.abortCalls > before, "autonomous wake turn must be aborted at turn_start");

	// The wake turn ends aborted; no continuation may follow.
	tasks = [];
	h.bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "t1", status: "completed" } });
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "aborted", content: [] }, toolResults: [] });
	await h.fire("agent_end", { messages: [] });
	await h.fire("agent_settled", {});
	await flush(80);
	assert.equal(
		h.state.sent.filter((m) => m.customType === GOAL_EVENT && String(m.content).includes(CONTINUATION_MARKER)).length,
		0,
		"no goal wake may fire while the stop is in effect",
	);
});
