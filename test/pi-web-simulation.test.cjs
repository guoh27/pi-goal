// High-fidelity simulation of pi-web's stop path, matching pi's built-in Node
// loader topology: the loader injects an alias that maps
// @earendil-works/pi-coding-agent to the RUNTIME's own copy (getAliases()), so
// the extension and pi-web share ONE AgentSession prototype — and the abort
// hook must cancel pending autonomous work in that topology.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");
const { join } = require("node:path");

const GLOBAL_PACKAGE = "/home/adv-server2/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

test("pi-web topology: AgentSession.abort() reaches the extension and cancels retries", async () => {
	process.env.PI_GOAL_RETRY_BASE_DELAY_MS = "5";
	process.env.PI_GOAL_RETRY_MAX_DELAY_MS = "40";
	process.env.PI_GOAL_BG_QUERY_TIMEOUT_MS = "15";
	process.env.PI_GOAL_BG_WAKE_GRACE_MS = "20";
	process.env.PI_GOAL_BG_WAIT_TIMEOUT_MS = "150";
	process.env.PI_GOAL_BG_PROBE_RETRY_DELAY_MS = "10";
	process.env.PI_GOAL_STOP_RACE_WINDOW_MS = "200";

	// 1. pi-web's copy of pi-coding-agent (runtime-side resolve).
	const { AgentSession } = require(GLOBAL_PACKAGE);

	// 2. extension loaded through jiti WITH the runtime alias (getAliases() maps
	// the specifier to the same runtime package the loader sits in).
	// Resolve the runtime packages to their real on-disk copies (what the
	// runtime alias getAliases() does): agent-core/tui come from the user
	// package store, coding-agent from the global runtime install.
	const RUNTIME_AGENT_CORE = "/home/adv-server2/.pi/my-extensions/pi-goal/node_modules/@earendil-works/pi-agent-core/dist/index.js";
	const RUNTIME_TUI = "/home/adv-server2/.pi/my-extensions/pi-goal/node_modules/@earendil-works/pi-tui/dist/index.js";
	const jiti = createJiti(__filename, {
		alias: {
			"@earendil-works/pi-coding-agent": GLOBAL_PACKAGE,
			"@earendil-works/pi-agent-core": RUNTIME_AGENT_CORE,
			"@earendil-works/pi-tui": RUNTIME_TUI,
		},
	});
	const { default: piGoal } = await jiti.import(join(__dirname, "../src/index.ts"));
	const harness = await jiti.import("./harness.cjs");
	const fake = harness.createFakePi();
	piGoal(fake.api);
	await fake.fire("session_start", { type: "session_start", reason: "startup" });
	await harness.flush(60);

	// 3. provider error → retry armed.
	await harness.simulateRun(fake, { role: "assistant", stopReason: "error", errorMessage: "503 status code", content: [] });

	// 4. pi-web Stop button while idle in the backoff window.
	const fakeSession = {
		sessionId: fake.state.sessionId,
		abortRetry() {},
		abortCompaction() {},
		abortBranchSummary() {},
		agent: { abort() {} },
		async waitForIdle() {},
	};
	await AgentSession.prototype.abort.call(fakeSession);

	// 5. the pending retry must be cancelled.
	await harness.flush(60);
	const retries = fake.state.sent.filter((m) => m.customType === "pi-goal:retry-trigger").length;
	assert.equal(retries, 0, "abort during backoff must cancel the pending retry (pi-web topology)");
});
