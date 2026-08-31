/**
 * Agent abort hook — makes every "stop" path observable to the extension.
 *
 * Problem: pi-web's Stop button, TUI interrupts, and RPC abort all funnel
 * into `AgentSession.abort()`. During the retry backoff window the agent is
 * idle, so `agent.abort()` is a silent no-op and NO extension event fires —
 * a pending retry keeps its timer and fires seconds later. The user sees
 * "I pressed stop and a retry message appeared anyway."
 *
 * Fix: wrap `AgentSession.prototype.abort`. Any caller (TUI / pi-web / RPC /
 * wechat / extensions) triggers the registered handler first, which cancels
 * pending autonomous work and marks the process stopped. The original abort
 * still runs untouched afterwards.
 */

import { AgentSession } from "@earendil-works/pi-coding-agent";

export type AgentAbortHandler = () => void;

type AbortFn = (this: unknown) => Promise<void>;
type SendCustomMessageFn = (this: unknown, message: unknown, options?: { triggerTurn?: boolean; deliverAs?: string }) => Promise<void>;

let handler: AgentAbortHandler | null = null;
/** Live AgentSession captured from the last abort call (every stop path funnels through it). */
let liveAgentSession: unknown = null;
/** While this predicate returns true, triggerTurn on custom messages is stripped (no autonomous run). */
let triggerTurnGuard: (() => boolean) | null = null;

export function setAgentAbortHandler(fn: AgentAbortHandler | null): void {
	handler = fn;
}

/** Predicate consulted by the sendCustomMessage patch; index.ts wires it to the user-stop flag. */
export function setTriggerTurnGuard(fn: (() => boolean) | null): void {
	triggerTurnGuard = fn;
}

export function getLiveAgentSession(): unknown {
	return liveAgentSession;
}

/** Test-only: drop the captured session so the ctx.abort() fallback is exercised. */
export function resetLiveAgentSessionForTests(): void {
	liveAgentSession = null;
}

export function onAgentAbort(): void {
	if (handler) {
		try {
			handler();
		} catch {
			// a broken handler must not break the abort path
		}
	}
}

const proto = AgentSession.prototype as unknown as {
	abort?: AbortFn & { __piGoalAbortHook?: boolean };
	sendCustomMessage?: SendCustomMessageFn & { __piGoalTriggerGuard?: boolean };
};

const origAbort = proto.abort;

if (typeof origAbort === "function" && !origAbort.__piGoalAbortHook) {
	const patched: AbortFn & { __piGoalAbortHook?: boolean } = function (this: unknown) {
		liveAgentSession = this;
		onAgentAbort();
		return origAbort.call(this);
	};
	patched.__piGoalAbortHook = true;
	proto.abort = patched;
}

/**
 * While the user stop is in effect, a custom message (e.g. the bg plugin's
 * <background-task-notification> with triggerTurn:true) must still be recorded
 * in the session but must NOT start a run. Strip triggerTurn so the message
 * lands quietly and the agent stays stopped until fresh user input.
 */
const origSendCustomMessage = proto.sendCustomMessage;

if (typeof origSendCustomMessage === "function" && !origSendCustomMessage.__piGoalTriggerGuard) {
	const patched: SendCustomMessageFn & { __piGoalTriggerGuard?: boolean } = async function (this: unknown, message, options) {
		if (options?.triggerTurn && triggerTurnGuard?.()) {
			return origSendCustomMessage.call(this, message, { ...options, triggerTurn: false });
		}
		return origSendCustomMessage.call(this, message, options);
	};
	patched.__piGoalTriggerGuard = true;
	proto.sendCustomMessage = patched;
}

/** No-op exported so the hook installs as a load side effect (asserted in tests). */
export function installAgentAbortHook(): void {
	// patched at module load
}