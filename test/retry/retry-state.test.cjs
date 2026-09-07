const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { calculateDelay, formatDuration, RetryState, ContinuationState, resolveRetryConfig, DEFAULT_BACKOFF_CONFIG } = jiti(
	"../../src/retry/retry-state.ts",
);
const { RetryEngine } = jiti("../../src/retry/retry-engine.ts");

test("calculateDelay follows the 2s → 4s → 8s curve capped at 60s", () => {
	assert.equal(calculateDelay(1), 2000);
	assert.equal(calculateDelay(2), 4000);
	assert.equal(calculateDelay(3), 8000);
	assert.equal(calculateDelay(4), 16000);
	assert.equal(calculateDelay(5), 32000);
	assert.equal(calculateDelay(6), 60000);
	assert.equal(calculateDelay(50), 60000);
});

test("formatDuration renders ms, s, and m", () => {
	assert.equal(formatDuration(250), "250ms");
	assert.equal(formatDuration(4000), "4.0s");
	assert.equal(formatDuration(65000), "1m 5s");
});

test("RetryState counts consecutive attempts and resets on success", () => {
	const state = new RetryState();
	state.startRetry("boom");
	state.endRetry();
	state.startRetry("boom again");
	assert.equal(state.getAttempt(), 2);
	state.succeed();
	assert.equal(state.getAttempt(), 0);
	assert.equal(state.getLastErrorMessage(), "");
});

test("ContinuationState completes and resets", () => {
	const state = new ContinuationState();
	state.startContinuation();
	state.endContinuation();
	assert.equal(state.getCount(), 1);
	state.complete();
	assert.equal(state.getCount(), 0);
});

test("resolveRetryConfig reads env overrides with pi-retry defaults", () => {
	const defaults = resolveRetryConfig({});
	assert.deepEqual(defaults, { enabled: true, baseDelayMs: 2000, maxDelayMs: 60000, quotaWaitMaxMs: 8 * 3600_000, quotaWaitMaxRounds: 3 });
	assert.deepEqual(resolveRetryConfig({ PI_GOAL_RETRY_BASE_DELAY_MS: "500" }).baseDelayMs, 500);
	assert.deepEqual(resolveRetryConfig({ PI_GOAL_RETRY_ENABLED: "false" }).enabled, false);
	assert.deepEqual(resolveRetryConfig({ PI_GOAL_QUOTA_WAIT_MAX_MS: "3600000" }).quotaWaitMaxMs, 3600000);
	assert.deepEqual(resolveRetryConfig({ PI_GOAL_QUOTA_WAIT_MAX_ROUNDS: "5" }).quotaWaitMaxRounds, 5);
	// Invalid values fall back to defaults.
	assert.deepEqual(resolveRetryConfig({ PI_GOAL_RETRY_MAX_DELAY_MS: "nope" }).maxDelayMs, 60000);
	assert.deepEqual(resolveRetryConfig({ PI_GOAL_QUOTA_WAIT_MAX_MS: "nope" }).quotaWaitMaxMs, 8 * 3600_000);
});

function errMsg(text) {
	return { role: "assistant", stopReason: "error", errorMessage: text, content: [] };
}

test("engine plans retries with growing backoff per category and resets on success", () => {
	const engine = new RetryEngine({ enabled: true, baseDelayMs: 1000, maxDelayMs: 8000 });
	const p1 = engine.planRecovery(engine.classify(errMsg("connection error")));
	assert.equal(p1.action, "retry");
	assert.equal(p1.attempt, 1);
	assert.equal(p1.delayMs, 1000);

	const p2 = engine.planRecovery(engine.classify(errMsg("ECONNRESET")));
	assert.equal(p2.attempt, 2);
	assert.equal(p2.delayMs, 2000);

	// A different category tracks its own streak.
	const c1 = engine.planRecovery(engine.classify(errMsg("not enough credits")));
	assert.equal(c1.category, "credit");
	assert.equal(c1.attempt, 1);

	engine.noteSuccess();
	const p3 = engine.planRecovery(engine.classify(errMsg("connection error")));
	assert.equal(p3.attempt, 1);

	// Cap respected from config.
	let last;
	for (let i = 0; i < 6; i++) last = engine.planRecovery(engine.classify(errMsg("fetch failed")));
	assert.equal(last.delayMs, 8000);
});

test("engine caps empty-stop nudges at one per streak", () => {
	const engine = new RetryEngine();
	const first = engine.planRecovery(engine.classify({ role: "assistant", stopReason: "stop", content: [] }));
	assert.equal(first.action, "nudge");
	const second = engine.planRecovery(engine.classify({ role: "assistant", stopReason: "stop", content: [] }));
	assert.equal(second.action, "stop"); // give up
	engine.noteSuccess(); // a usable turn restores the nudge budget
	const third = engine.planRecovery(engine.classify({ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "x" }] }));
	assert.equal(third.action, "nudge");
});

test("engine classifies aborted/normal/length outcomes without planning recovery", () => {
	const engine = new RetryEngine();
	assert.equal(engine.classify({ role: "assistant", stopReason: "aborted" }).kind, "aborted");
	assert.equal(engine.classify(null).kind, "none");
	const lengthPlan = engine.planRecovery(engine.classify({ role: "assistant", stopReason: "length", content: [] }));
	assert.equal(lengthPlan.action, "continue");
	assert.equal(lengthPlan.delayMs, 0);
});
