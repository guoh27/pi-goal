const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	PiBackgroundTasksAdapter,
	BG_REQUEST_CHANNEL,
	BG_RESPONSE_CHANNEL,
	BG_TERMINAL_CHANNEL,
} = jiti("../../src/background/pi-background-tasks-adapter.ts");
const {
	PiSubagentsAdapter,
	SUBAGENT_RPC_REQUEST_EVENT,
} = jiti("../../src/background/pi-subagents-adapter.ts");
const { BackgroundWorkManager } = jiti("../../src/background/manager.ts");
const { ensureBackgroundWorkRegistry, registerBackgroundWorkProvider, unknownSnapshot } = jiti(
	"../../src/background/types.ts",
);

function makeBus() {
	const listeners = new Map();
	return {
		emit(channel, data) {
			const ls = listeners.get(channel);
			if (ls) for (const fn of [...ls]) fn(data);
		},
		on(channel, fn) {
			if (!listeners.has(channel)) listeners.set(channel, new Set());
			listeners.get(channel).add(fn);
			return () => listeners.get(channel)?.delete(fn);
		},
		listenerCount: (c) => listeners.get(c)?.size ?? 0,
	};
}

function flush(ms = 20) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("open registry: third parties can register via Symbol.for without importing pi-goal", async () => {
	const key = Symbol.for("pi-goal.background-work.v1");
	// Simulate a foreign extension creating/consuming the documented protocol.
	const reg = ensureBackgroundWorkRegistry();
	assert.equal(reg.version, 1);
	assert.ok(reg.providers instanceof Map);
	let queried = 0;
	const dispose = registerBackgroundWorkProvider({
		name: "my-foreign-plugin",
		async getActiveWork() {
			queried++;
			return { provider: "my-foreign-plugin", activeCount: 2, activeIds: ["a", "b"], state: "known", checkedAt: Date.now() };
		},
	});
	const manager = new BackgroundWorkManager(makeBus(), { queryTimeoutMs: 50 });
	const snap = await manager.snapshot("session-1");
	assert.equal(snap.totalActive >= 2, true);
	assert.equal(queried >= 1, true);
	dispose();
});

test("malformed provider registration is rejected", () => {
	assert.throws(() => registerBackgroundWorkProvider({ name: "bad" }));
});

test("unknownSnapshot fails closed with state unknown", () => {
	assert.equal(unknownSnapshot("x").state, "unknown");
});

test("bg-tasks adapter: status reply counts running tasks; terminal events signal change", async () => {
	const bus = makeBus();
	bus.on(BG_REQUEST_CHANNEL, (request) => {
		if (request.operation === "capabilities") {
			bus.emit(BG_RESPONSE_CHANNEL, { schema_version: "x", request_id: request.request_id, operation: request.operation, ok: true, result: { api_version: 1 } });
			return;
		}
		bus.emit(BG_RESPONSE_CHANNEL, {
			schema_version: "x",
			request_id: request.request_id,
			operation: request.operation,
			ok: true,
			result: { tasks: [{ id: "t1", status: "running" }, { id: "t2", status: "running" }, { id: "t3", status: "completed" }] },
		});
	});
	const adapter = new PiBackgroundTasksAdapter(bus, { queryTimeoutMs: 100 });
	await flush();
	const snap = await adapter.getActiveWork("s1");
	assert.equal(snap.state, "known");
	assert.deepEqual(snap.activeIds.sort(), ["t1", "t2"]);
	assert.equal(snap.activeCount, 2);

	let signaled = 0;
	adapter.subscribe(() => signaled++);
	bus.emit(BG_TERMINAL_CHANNEL, { schema_version: "y", task: { id: "t1", status: "completed" } });
	assert.equal(signaled, 1);

	// Terminal event is only a signal — snapshot still authoritative until re-query.
	const snap2 = await adapter.getActiveWork("s1");
	assert.equal(snap2.activeCount, 2);
});

test("bg-tasks adapter: timeout / malformed response fail closed as unknown", async () => {
	const bus = makeBus(); // no responder at all
	const adapter = new PiBackgroundTasksAdapter(bus, { queryTimeoutMs: 15 });
	const snap = await adapter.getActiveWork("s1");
	assert.equal(snap.state, "unknown");

	// A malformed ok:false reply also fails closed.
	bus.on(BG_REQUEST_CHANNEL, (request) => {
		bus.emit(BG_RESPONSE_CHANNEL, { schema_version: "x", request_id: request.request_id, operation: request.operation, ok: false, error: "boom" });
	});
	const snap2 = await adapter.getActiveWork("s1");
	assert.equal(snap2.state, "unknown");
});

test("subagents adapter: fleet.totalActive is authoritative; entries bounded ids fine", async () => {
	const bus = makeBus();
	bus.on(SUBAGENT_RPC_REQUEST_EVENT, (request) => {
		assert.equal(request.method, "status");
		bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			success: true,
			data: { fleet: { version: 1, totalActive: 3, entries: [{ key: "fleet-1" }, { key: "fleet-2" }] } },
		});
	});
	const adapter = new PiSubagentsAdapter(bus, { queryTimeoutMs: 100 });
	await flush();
	const snap = await adapter.getActiveWork("s1");
	assert.equal(snap.state, "known");
	assert.equal(snap.activeCount, 3); // count from totalActive even with fewer entries
	assert.deepEqual(snap.activeIds, ["fleet-1", "fleet-2"]);
});

test("subagents adapter: error reply fails closed", async () => {
	const bus = makeBus();
	bus.on(SUBAGENT_RPC_REQUEST_EVENT, (request) => {
		bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			success: false,
			error: { code: "execution_failed", message: "no session" },
		});
	});
	const adapter = new PiSubagentsAdapter(bus, { queryTimeoutMs: 50 });
	const snap = await adapter.getActiveWork("s1");
	assert.equal(snap.state, "unknown");
});

test("presence: two dead probes mark an absent plugin so it never blocks goals", async () => {
	const bus = makeBus(); // silent bus → probes time out
	const manager = new BackgroundWorkManager(bus, { queryTimeoutMs: 10 });
	await flush(400); // initial probe + spaced retry both fail
	const snap = await manager.snapshot("session-1");
	assert.equal(snap.hasProviders, false);
	assert.equal(snap.anyUnknown, false);
	assert.equal(snap.totalActive, 0);
});

test("manager aggregates multiple providers and reports unknown fail-closed", async () => {
	const bus = makeBus();
	let saBroken = false;
	respondBg(bus, [{ id: "t1", status: "running" }]);
	bus.on(SUBAGENT_RPC_REQUEST_EVENT, (request) => {
		if (saBroken) return; // dead plugin: no reply
		bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			success: true,
			data: { fleet: { totalActive: 1, entries: [{ key: "k1" }] } },
		});
	});
	const manager = new BackgroundWorkManager(bus, { queryTimeoutMs: 200 });
	await flush();
	const snap1 = await manager.snapshot("s1");
	assert.equal(snap1.totalActive, 2);
	assert.equal(snap1.anyUnknown, false);
	assert.deepEqual([...snap1.activeIds].sort(), ["k1", "t1"]);

	// subagents starts failing → aggregate unknown while bg still busy.
	saBroken = true;
	const snap2 = await manager.snapshot("s1");
	assert.equal(snap2.totalActive >= 1, true); // bg task still counted
	assert.equal(snap2.anyUnknown, true);

	function respondBg(busRef, tasks) {
		busRef.on(BG_REQUEST_CHANNEL, (request) => {
			if (request.operation === "capabilities") {
				busRef.emit(BG_RESPONSE_CHANNEL, { schema_version: "x", request_id: request.request_id, operation: request.operation, ok: true, result: {} });
				return;
			}
			busRef.emit(BG_RESPONSE_CHANNEL, { schema_version: "x", request_id: request.request_id, operation: request.operation, ok: true, result: { tasks } });
		});
	}
});

test("manager.subscribeAll wires change signals from built-in adapters", async () => {
	const bus = makeBus();
	const manager = new BackgroundWorkManager(bus, { queryTimeoutMs: 50 });
	let signals = 0;
	manager.subscribeAll(() => signals++);
	bus.emit("subagent:async-complete", {});
	bus.emit("pi-background-tasks:terminal:v1", { schema_version: "x", task: { id: "z" } });
	assert.equal(signals, 2);
});

test("stale ctx bus (on/emit throw after session replacement) fails closed, never rejects", async () => {
	// Simulates pi's session-bound event bus after ctx.newSession()/reload():
	// every use throws the stale-ctx error from the extension runtime.
	const staleBus = {
		on() {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
		emit() {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	};
	const unhandled = [];
	const onUnhandled = (err) => unhandled.push(err);
	process.on("unhandledRejection", onUnhandled);
	try {
		// Constructor subscriptions throw too — that's out of scope here; build
		// adapters against a healthy bus, then swap to the stale one.
		const bus = makeBus();
		respondOk(bus);
		const bg = new PiBackgroundTasksAdapter(bus, { queryTimeoutMs: 20, probeRetryDelayMs: 10 });
		const sa = new PiSubagentsAdapter(bus, { queryTimeoutMs: 20, probeRetryDelayMs: 10 });
		await flush();
		bg.events = staleBus;
		sa.events = staleBus;

		const snapBg = await bg.getActiveWork("s1");
		const snapSa = await sa.getActiveWork("s1");
		assert.equal(snapBg.state, "unknown");
		assert.equal(snapSa.state, "unknown");
		await flush(50); // give any stray rejection a chance to surface
		assert.deepEqual(unhandled, []);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}

	function respondOk(busRef) {
		busRef.on(BG_REQUEST_CHANNEL, (request) => {
			busRef.emit(BG_RESPONSE_CHANNEL, { request_id: request.request_id, ok: true, result: { tasks: [] } });
		});
		busRef.on(SUBAGENT_RPC_REQUEST_EVENT, (request) => {
			busRef.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: true,
				data: { fleet: { totalActive: 0, entries: [] } },
			});
		});
	}
});
