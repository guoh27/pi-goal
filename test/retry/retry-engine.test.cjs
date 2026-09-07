/**
 * RetryEngine planRecovery tests for the usage-limit reset-window behavior:
 *
 * - a normal stop is never a retry target (explicit stop action)
 * - quota errors WITHOUT a stated reset window halt (no pointless retries)
 * - quota errors WITH a window ("Try again in ~135 min.") schedule ONE retry
 *   delayed to the reset time instead of short backoff spam or instant halt
 * - window longer than the configured cap (e.g. "Resets in 7 days") halts
 * - consecutive windowed waits are bounded (quotaWaitMaxRounds) then halt
 * - success/abort reset the wait streak
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { RetryEngine } = jiti("../../src/retry/retry-engine.ts");

const MIN = 60_000;

const CONFIG = {
	enabled: true,
	baseDelayMs: 5,
	maxDelayMs: 40,
	quotaWaitMaxMs: 8 * 3600_000, // 8h
	quotaWaitMaxRounds: 2,
};

function engine(overrides = {}) {
	return new RetryEngine({ ...CONFIG, ...overrides });
}

function quotaOutcome(text) {
	const engineProbe = new RetryEngine({ ...CONFIG });
	return engineProbe.classify({
		role: "assistant",
		stopReason: "error",
		errorMessage: text,
		content: [],
	});
}

test("a normal stop is never planned as a retry", () => {
	const e = engine();
	for (const outcome of [{ kind: "normal" }, { kind: "none" }]) {
		const plan = e.planRecovery(outcome);
		assert.equal(plan.action, "stop");
		assert.equal(plan.delayMs, 0);
	}
});

test("quota error with a reset window schedules ONE retry at the reset time", () => {
	const e = engine();
	const outcome = quotaOutcome("You have hit your ChatGPT usage limit (plus plan). Try again in ~135 min.");
	assert.equal(outcome.kind, "error_quota");

	const plan = e.planRecovery(outcome);
	assert.equal(plan.action, "retry");
	assert.equal(plan.delayMs, 135 * MIN);
	assert.equal(plan.attempt, 1);
	assert.equal(plan.triggerContent, "Retry the previous request.");
	assert.match(plan.notify.text, /135 min|2h 15m/);
	assert.match(plan.notify.text, /round 1\/2/);
});

test("quota error without a window halts instead of retrying", () => {
	const e = engine();
	const plan = e.planRecovery(quotaOutcome('429: {"type":"FreeUsageLimitError","message":"Console upstream refused"}'));
	assert.equal(plan.action, "halt_goal_notify");
	assert.equal(plan.delayMs, 0);
	assert.equal(e.getQuotaWaitCount(), 0, "no window → no wait streak consumed");
});

test("window beyond the wait cap halts (e.g. Resets in 7 days)", () => {
	const e = engine();
	const plan = e.planRecovery(quotaOutcome("Monthly usage limit reached. Resets in 7 days."));
	assert.equal(plan.action, "halt_goal_notify");
	assert.equal(plan.delayMs, 0);
});

test("consecutive windowed waits are bounded, then the loop halts", () => {
	const e = engine();
	const round1 = e.planRecovery(quotaOutcome("usage limit hit, try again in ~60 min."));
	assert.equal(round1.action, "retry");
	assert.equal(round1.delayMs, 60 * MIN);
	assert.equal(e.getQuotaWaitCount(), 1);

	const round2 = e.planRecovery(quotaOutcome("usage limit hit, try again in ~45 min."));
	assert.equal(round2.action, "retry");
	assert.equal(round2.delayMs, 45 * MIN);
	assert.equal(e.getQuotaWaitCount(), 2);

	// Round 3 exceeds quotaWaitMaxRounds=2 → halt.
	const round3 = e.planRecovery(quotaOutcome("usage limit hit, try again in ~30 min."));
	assert.equal(round3.action, "halt_goal_notify");
	assert.match(round3.notify.text, /Still usage-limited/);
});

test("a successful turn resets the quota wait streak", () => {
	const e = engine();
	e.planRecovery(quotaOutcome("usage limit hit, try again in ~60 min."));
	assert.equal(e.getQuotaWaitCount(), 1);
	e.noteSuccess();
	assert.equal(e.getQuotaWaitCount(), 0);

	const again = e.planRecovery(quotaOutcome("usage limit hit, try again in ~60 min."));
	assert.equal(again.attempt, 1, "streak starts fresh after success");
});

test("abort resets the quota wait streak", () => {
	const e = engine();
	e.planRecovery(quotaOutcome("usage limit hit, try again in ~60 min."));
	e.noteAbort();
	assert.equal(e.getQuotaWaitCount(), 0);
});

test("retryable errors keep their normal short backoff (unaffected by quota waits)", () => {
	const e = engine();
	const outcome = quotaOutcome("Connection error.");
	assert.equal(outcome.kind, "error_retryable");
	const plan = e.planRecovery(outcome);
	assert.equal(plan.action, "retry");
	assert.equal(plan.delayMs, 5, "backoff attempt 1");
	assert.equal(e.getQuotaWaitCount(), 0);
});
