/**
 * Fake ExtensionAPI harness for behavioral tests of the merged pi-goal
 * extension. Simulates the pi extension runtime surface used by index.ts:
 * event dispatch, tools, commands, sendMessage capture, an EventBus, and a
 * session manager — no real model or TUI involved.
 */

const { createJiti } = require("jiti");
const { join } = require("node:path");

const EXTENSION_INDEX = join(__dirname, "../src/index.ts");

function createFakePi(options = {}) {
	const state = {
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		sent: [],
		triggerTurnCount: 0,
		entries: [],
		sessionEntries: options.sessionEntries ?? [],
		notifications: [],
		statuses: new Map(),
		activeTools: ["read", "bash", "edit", "write"],
		busListeners: new Map(),
		sessionId: "session-1",
		idle: true,
		pendingMessages: false,
		confirmResult: true,
		terminalInputHandlers: [],
		abortCalls: 0,
	};

	const bus = {
		emit(channel, data) {
			const listeners = state.busListeners.get(channel);
			if (!listeners) return;
			for (const fn of [...listeners]) fn(data);
		},
		on(channel, fn) {
			if (!state.busListeners.has(channel)) state.busListeners.set(channel, new Set());
			state.busListeners.get(channel).add(fn);
			return () => state.busListeners.get(channel)?.delete(fn);
		},
		listenerCount: (channel) => state.busListeners.get(channel)?.size ?? 0,
	};

	const api = {
		on(event, handler) {
			if (!state.handlers.has(event)) state.handlers.set(event, []);
			state.handlers.get(event).push(handler);
		},
		registerTool(tool) {
			state.tools.set(tool.name, tool);
		},
		registerCommand(name, opts) {
			state.commands.set(name, opts);
		},
		registerMessageRenderer() {},
		registerMarkdownTransformer() {},
		sendMessage(msg, options) {
			state.sent.push({ customType: msg.customType, content: msg.content, display: msg.display, details: msg.details, options: options ?? {} });
			if (options?.triggerTurn) state.triggerTurnCount++;
			return Promise.resolve();
		},
		sendUserMessage() {},
		appendEntry(type, data) {
			state.entries.push({ type, data });
			// Custom entries are part of the session journal in real pi.
			state.sessionEntries.push({ type: "custom", customType: type, data });
		},
		getActiveTools: () => [...state.activeTools],
		setActiveTools(names) {
			state.activeTools = names;
		},
		getAllTools: () => [],
		getCommands: () => [],
		events: bus,
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		setSessionName() {},
		getSessionName: () => undefined,
		setLabel() {},
		setModel: async () => true,
		getThinkingLevel: () => "off",
		setThinkingLevel() {},
		registerProvider() {},
		unregisterProvider() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag: () => undefined,
	};

	function makeCtx(overrides = {}) {
		return {
			ui: {
				notify: (text, level) => state.notifications.push({ text, level }),
				setStatus: (key, value) => state.statuses.set(key, value),
				confirm: async () => state.confirmResult,
				select: async () => undefined,
				input: async () => undefined,
				onTerminalInput: (handler) => {
					state.terminalInputHandlers.push(handler);
					return () => {
						const i = state.terminalInputHandlers.indexOf(handler);
						if (i >= 0) state.terminalInputHandlers.splice(i, 1);
					};
				},
				...overrides.ui,
			},
			mode: "tui",
			hasUI: true,
			cwd: "/tmp/project",
			sessionManager: {
				getEntries: () => state.sessionEntries,
				getBranch: () => state.sessionEntries,
				getSessionId: () => state.sessionId,
				getSessionFile: () => null,
				getLeafId: () => null,
				getLeafEntry: () => null,
				getEntry: () => null,
				getLabel: () => undefined,
				buildContextEntries: () => [],
				getHeader: () => ({}),
				getTree: () => [],
				getCwd: () => "/tmp/project",
				getSessionDir: () => "/tmp",
			},
			modelRegistry: {},
			model: undefined,
			scopedModels: [],
			isIdle: () => state.idle,
			isProjectTrusted: () => true,
			signal: overrides.signal,
			abort() {
				state.abortCalls += 1;
			},
			hasPendingMessages: () => state.pendingMessages,
			shutdown() {},
			getContextUsage: () => undefined,
			compact() {},
			getSystemPrompt: () => "",
		};
	}

	async function fire(eventName, evt = {}, ctxOverrides = {}) {
		const handlers = state.handlers.get(eventName) ?? [];
		const ctx = makeCtx(ctxOverrides);
		for (const handler of handlers) await handler(evt, ctx);
	}

	/** Simulate a raw Escape keypress in the TUI (reaches onTerminalInput hooks). */
	function pressEscape() {
		for (const handler of [...state.terminalInputHandlers]) handler("\x1b");
	}

	return { api, state, bus, makeCtx, fire, pressEscape };
}

let jitiInstance = null;
async function loadExtension() {
	if (!jitiInstance) jitiInstance = createJiti(__filename);
	return jitiInstance.import(EXTENSION_INDEX);
}

// ── message helpers ──

function assistantMessage(overrides = {}) {
	return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], ...overrides };
}

function errorMessage(text, overrides = {}) {
	return assistantMessage({ stopReason: "error", errorMessage: text, content: [], ...overrides });
}

function lengthMessage() {
	return assistantMessage({ stopReason: "length", content: [{ type: "text", text: "partial" }] });
}

function emptyStopMessage() {
	return assistantMessage({ stopReason: "stop", content: [{ type: "thinking", thinking: "hmm" }] });
}

/** Push an assistant message into the fake session and simulate a full run. */
async function simulateRun(harness, message, opts = {}) {
	harness.state.sessionEntries.push({ type: "message", message });
	await harness.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await harness.fire("turn_end", { turnIndex: 0, message, toolResults: [] }, opts.ctxOverrides);
	await harness.fire("agent_end", { messages: [message] }, opts.agentEndCtx);
	if (opts.skipSettled !== true) await harness.fire("agent_settled", {});
}

const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// ── background plugin responders ──

/**
 * Simulate npm:pi-background-tasks answering on its public EventBus channels.
 * `getTasks` returns the current task list (array of BgTaskSnapshot-like).
 */
function respondBackgroundTasks(harness, getTasks) {
	harness.bus.on("pi-background-tasks:request:v1", (request) => {
		let ok = true;
		let result;
		if (request.operation === "capabilities") {
			result = { api_version: 1, run: true, status: true, logs: true, kill: true };
		} else if (request.operation === "status") {
			result = { tasks: getTasks(request) };
		} else {
			ok = false;
		}
		harness.bus.emit("pi-background-tasks:response:v1", {
			schema_version: "pi-background-tasks.extension-response.v1",
			request_id: request.request_id,
			operation: request.operation,
			ok,
			result,
		});
	});
}

/**
 * Simulate npm:pi-subagents RPC bridge. `getData` returns the RPC `data`
 * payload for a status request (include fleet.totalActive etc.).
 */
function respondSubagents(harness, getData) {
	harness.bus.on("subagents:rpc:v1:request", (request) => {
		const data = typeof getData === "function" ? getData(request) : getData;
		harness.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			method: request.method,
			success: true,
			data,
		});
	});
}

module.exports = {
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
};
