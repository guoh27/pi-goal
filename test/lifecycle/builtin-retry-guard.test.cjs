// The builtin retry guard must make pi's own _prepareRetry step aside while
// the merged engine owns recovery — otherwise the two engines race and the
// user sees an unstoppable retry storm (verified against a real pi session:
// zero `auto_retry_start` events once the guard is active).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);

test("guard installs a patched _prepareRetry on AgentSession.prototype", async () => {
	// Load both through the same jiti instance so they share module identity.
	const { AgentSession } = await jiti.import("../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const guard = await jiti.import("../../src/lifecycle/builtin-retry-guard.ts");

	guard.installBuiltinRetryGuard();
	const proto = AgentSession.prototype;
	assert.equal(typeof proto._prepareRetry, "function");
	assert.equal(proto._prepareRetry.__piGoalRetryGuard, true);

	// While the merged engine drives recovery, builtin retry must decline.
	guard.setRecoveryActivityCheck(() => true);
	assert.equal(guard.isRecoveryDriving(), true);
	const result = await proto._prepareRetry.call({ _retryAttempt: 0 }, "boom-msg");
	assert.equal(result, false);

	// When not driving, the guard reports false (original behavior restored).
	guard.setRecoveryActivityCheck(() => false);
	assert.equal(guard.isRecoveryDriving(), false);
	guard.setRecoveryActivityCheck(null);
});

test("recovery checks are isolated per session in a multi-session host", async () => {
	const { AgentSession } = await jiti.import("../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const guard = await jiti.import("../../src/lifecycle/builtin-retry-guard.ts");

	const releaseA = guard.bindRecoveryActivityCheck("session-a", () => true);
	const releaseB = guard.bindRecoveryActivityCheck("session-b", () => false);

	// Session A's engine driving must suppress only A's builtin retry.
	const resultA = await AgentSession.prototype._prepareRetry.call({ sessionId: "session-a", _retryAttempt: 0 }, "boom");
	assert.equal(resultA, false);
	assert.equal(guard.isRecoveryDriving("session-a"), true);
	assert.equal(guard.isRecoveryDriving("session-b"), false);

	releaseA();
	releaseB();
});
