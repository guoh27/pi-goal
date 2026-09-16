// pi-web's Stop button calls AgentSession.abort(). While the agent is idle in
// a retry backoff window that abort used to be a silent no-op — no extension
// event, pending retry fires anyway. The abort hook must surface stops to the
// extension from ANY caller (TUI / pi-web / RPC / wechat).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);

test("AgentSession.abort is wrapped and fires the registered handler", async () => {
	const { AgentSession } = await jiti.import("../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const hook = await jiti.import("../../src/lifecycle/agent-abort-hook.ts");
	hook.installAgentAbortHook();
	const proto = AgentSession.prototype;
	assert.equal(proto.abort.__piGoalAbortHook, true);

	let calls = 0;
	hook.setAgentAbortHandler(() => calls++);

	// Simulate pi-web's Stop during the idle backoff window: session.abort()
	// with nothing running (abortRetry + agent.abort no-op + waitForIdle).
	const fakeSession = {
		abortRetry() {},
		agent: { abort() {} },
		async waitForIdle() {},
	};
	await proto.abort.call(fakeSession);
	assert.equal(calls, 1, "abort handler must fire even when the agent is idle");

	hook.setAgentAbortHandler(null);
});

test("session guards are isolated in a multi-session host such as pi-web", async () => {
	const hook = await jiti.import("../../src/lifecycle/agent-abort-hook.ts");
	const releaseA = hook.bindAgentSessionHooks("session-a", {
		onAbort() {},
		shouldSuppressTriggerTurn: () => false,
	});
	const releaseB = hook.bindAgentSessionHooks("session-b", {
		onAbort() {},
		shouldSuppressTriggerTurn: () => true,
	});

	assert.equal(hook.shouldSuppressTriggerTurnForSession("session-a"), false);
	assert.equal(hook.shouldSuppressTriggerTurnForSession("session-b"), true);

	releaseA();
	releaseB();
});

test("trailing error cleanup only touches the owning session's agent", async () => {
	const hook = await jiti.import("../../src/lifecycle/agent-abort-hook.ts");
	const errA = { role: "assistant", stopReason: "error" };
	const errB = { role: "assistant", stopReason: "error" };
	const agentA = { state: { messages: [{ role: "user" }, errA] } };
	const agentB = { state: { messages: [{ role: "user" }, errB] } };
	hook.noteLiveAgentSession({ sessionId: "session-a", agent: agentA });
	hook.noteLiveAgentSession({ sessionId: "session-b", agent: agentB });

	assert.equal(hook.removeTrailingErrorForSession("session-a"), true);
	assert.deepEqual(agentA.state.messages, [{ role: "user" }]);
	assert.equal(agentB.state.messages.length, 2, "another session's agent state must stay untouched");
});

test("abort hook fires during an active run too", async () => {
	const { AgentSession } = await jiti.import("../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const hook = await jiti.import("../../src/lifecycle/agent-abort-hook.ts");

	let calls = 0;
	hook.setAgentAbortHandler(() => calls++);
	let abortedInner = false;
	const fakeSession = {
		abortRetry() {},
		agent: {
			abort() {
				abortedInner = true;
			},
		},
		async waitForIdle() {},
	};
	await AgentSession.prototype.abort.call(fakeSession);
	assert.equal(calls, 1);
	assert.equal(abortedInner, true, "the original abort must still run after the hook");
	hook.setAgentAbortHandler(null);
});
