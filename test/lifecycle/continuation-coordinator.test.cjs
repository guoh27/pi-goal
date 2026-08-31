const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { ContinuationCoordinator, priorityOf } = jiti("../../src/lifecycle/continuation-coordinator.ts");

/** Deterministic clock + timer queue for coordinator tests. */
function fakeClock() {
	let nowMs = 0;
	const timers = new Map();
	let nextId = 1;
	const setTimeoutFn = (handler, ms) => {
		const id = nextId++;
		timers.set(id, { at: nowMs + ms, handler });
		return id;
	};
	const clearTimeoutFn = (id) => timers.delete(id);
	const advance = async (ms) => {
		for (let stepped = 0; stepped <= ms; stepped += 1) {
			nowMs += 1;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= nowMs) {
					timers.delete(id);
					timer.handler();
				}
			}
			await Promise.resolve();
		}
	};
	return { now: () => nowMs, setTimeoutFn, clearTimeoutFn, advance, pendingCount: () => timers.size };
}

function makeCoordinator(overrides = {}) {
	const clock = fakeClock();
	const events = [];
	const coordinator = new ContinuationCoordinator({
		now: clock.now,
		setTimeout: clock.setTimeoutFn,
		clearTimeout: clock.clearTimeoutFn,
		onEvent: (e) => events.push(e),
		guard: overrides.guard,
	});
	return { coordinator, clock, events };
}

test("priority order matches the design contract", () => {
	assert.ok(priorityOf("provider_retry") > priorityOf("max_tokens_continue"));
	assert.ok(priorityOf("max_tokens_continue") > priorityOf("empty_response_nudge"));
	assert.ok(priorityOf("empty_response_nudge") > priorityOf("background_completion_wake"));
	assert.ok(priorityOf("background_completion_wake") > priorityOf("goal_continue"));
});

test("only one autonomous turn is scheduled at a time; same priority is ignored", async () => {
	const { coordinator, clock } = makeCoordinator();
	let goalRan = 0;
	let retryRan = 0;
	assert.equal(coordinator.requestTurn({ reason: "goal_continue", delayMs: 10, execute: () => goalRan++ }), true);
	assert.equal(coordinator.hasPending(), true);
	// A second same-priority request must not create a second slot.
	assert.equal(coordinator.requestTurn({ reason: "goal_continue", delayMs: 5, execute: () => goalRan++ }), false);
	// A higher-priority request takes over the single slot.
	assert.equal(coordinator.requestTurn({ reason: "provider_retry", delayMs: 20, execute: () => retryRan++ }), true);
	await clock.advance(100);
	assert.equal(goalRan, 0); // displaced
	assert.equal(retryRan, 1);
});

test("higher-priority request displaces a lower-priority pending one", async () => {
	const { coordinator, clock, events } = makeCoordinator();
	let ran = {};
	coordinator.requestTurn({ reason: "goal_continue", delayMs: 50, execute: () => { ran.goal = (ran.goal ?? 0) + 1; } });
	coordinator.requestTurn({ reason: "provider_retry", delayMs: 60, execute: () => { ran.retry = (ran.retry ?? 0) + 1; } });
	assert.deepEqual(events.filter((e) => e.type === "displaced"), [{ type: "displaced", reason: "goal_continue", by: "provider_retry" }]);
	await clock.advance(100);
	assert.equal(ran.goal, undefined); // displaced intent never fires
	assert.equal(ran.retry, 1);
});

test("lower-priority request does not displace a higher-priority pending one", async () => {
	const { coordinator, clock } = makeCoordinator();
	let ran = {};
	coordinator.requestTurn({ reason: "provider_retry", delayMs: 30, execute: () => { ran.retry = 1; } });
	assert.equal(coordinator.requestTurn({ reason: "goal_continue", delayMs: 0, execute: () => { ran.goal = 1; } }), false);
	await clock.advance(50);
	assert.equal(ran.retry, 1);
	assert.equal(ran.goal, undefined);
});

test("invalidateAll drops pending actions and stale-generation callbacks never fire", async () => {
	const { coordinator, clock } = makeCoordinator();
	let fired = 0;
	coordinator.requestTurn({
		reason: "goal_continue",
		delayMs: 40,
		execute: () => {
			fired++;
		},
	});
	coordinator.invalidateAll("goal-cleared");
	assert.equal(coordinator.getPending(), null);
	await clock.advance(100);
	assert.equal(fired, 0);

	// A callback captured from an older generation is rejected even if it runs.
	const oldGeneration = coordinator.getGeneration();
	coordinator.requestTurn({ reason: "goal_continue", delayMs: 10, execute: () => { fired++; } });
	coordinator.invalidateAll("user-input");
	await clock.advance(50);
	assert.equal(fired, 0);
	assert.notEqual(oldGeneration, coordinator.getGeneration());
});

test("guard re-runs at fire time, not only at schedule time", async () => {
	let allow = false;
	const { coordinator, clock, events } = makeCoordinator({
		guard: () => allow,
	});
	let executed = 0;
	coordinator.requestTurn({
		reason: "goal_continue",
		delayMs: 10,
		execute: () => {
			executed++;
		},
	});
	await clock.advance(20); // guard rejects
	assert.equal(executed, 0);
	assert.ok(events.some((e) => e.type === "dropped" && e.why === "guard-rejected"));

	allow = true;
	coordinator.requestTurn({
		reason: "goal_continue",
		delayMs: 10,
		execute: () => {
			executed++;
		},
	});
	await clock.advance(20);
	assert.equal(executed, 1);
});

test("fired events report the generation that owned them", async () => {
	const { coordinator, clock, events } = makeCoordinator({ guard: () => true });
	coordinator.requestTurn({ reason: "provider_retry", delayMs: 10, execute: () => {} });
	await clock.advance(20);
	const fired = events.find((e) => e.type === "fired");
	assert.equal(fired.reason, "provider_retry");
	assert.equal(fired.generation, coordinator.getGeneration());
});

test("cancelPending clears the slot without bumping the generation", () => {
	const { coordinator } = makeCoordinator();
	coordinator.requestTurn({ reason: "max_tokens_continue", delayMs: 10, execute: () => {} });
	const generationBefore = coordinator.getGeneration();
	assert.equal(coordinator.cancelPending(), true);
	assert.equal(coordinator.hasPending(), false);
	assert.equal(coordinator.getGeneration(), generationBefore);
});

test("phase transitions are tracked for the status surface", () => {
	const { coordinator } = makeCoordinator();
	coordinator.setPhase("waiting_for_background");
	assert.equal(coordinator.getPhase(), "waiting_for_background");
	coordinator.invalidateAll("x");
	assert.equal(coordinator.getPhase(), "idle");
});
