/**
 * Agent abort hook — makes every "stop" path observable to the owning extension.
 *
 * pi-web keeps multiple AgentSession instances in one Node process, so hook
 * state must be keyed by session id. A process-global single handler lets one
 * stopped tab suppress triggerTurn notifications in every other tab.
 */

import { AgentSession } from "@earendil-works/pi-coding-agent";

export type AgentAbortHandler = () => void;

export interface AgentSessionHooks {
	onAbort: AgentAbortHandler;
	shouldSuppressTriggerTurn: () => boolean;
}

type AbortFn = (this: unknown) => Promise<void>;
type SendCustomMessageFn = (this: unknown, message: unknown, options?: { triggerTurn?: boolean; deliverAs?: string }) => Promise<void>;

const hooksBySessionId = new Map<string, AgentSessionHooks>();
const liveAgentSessions = new Map<string, unknown>();
// Backward-compatible fallback for non-session test harnesses and older hosts.
let fallbackAbortHandler: AgentAbortHandler | null = null;
let fallbackTriggerTurnGuard: (() => boolean) | null = null;
let fallbackLiveAgentSession: unknown = null;

function sessionIdOf(session: unknown): string | null {
	const value = (session as { sessionId?: unknown } | null)?.sessionId;
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Record a live AgentSession so other patches can reach its agent per session. */
export function noteLiveAgentSession(session: unknown): void {
	const sessionId = sessionIdOf(session);
	if (sessionId) liveAgentSessions.set(sessionId, session);
	else fallbackLiveAgentSession = session;
}

type AgentWithMessages = { state: { messages: Array<Record<string, unknown>> } };

/**
 * Drop a trailing assistant error from the live agent state of ONE session
 * (retry cleanup, same technique as upstream pi-retry). Never touches another
 * session's agent. Returns true when a message was removed.
 */
export function removeTrailingErrorForSession(sessionId: string | null): boolean {
	const session = (sessionId ? liveAgentSessions.get(sessionId) : fallbackLiveAgentSession) as
		| { agent?: AgentWithMessages }
		| null
		| undefined;
	const messages = session?.agent?.state?.messages;
	if (!messages) return false;
	const lastMsg = messages[messages.length - 1];
	if (lastMsg?.role !== "assistant" || lastMsg.stopReason !== "error") return false;
	session!.agent!.state.messages = messages.slice(0, -1);
	return true;
}

/** Register hooks for one AgentSession. The disposer only removes this exact registration. */
export function bindAgentSessionHooks(sessionId: string, hooks: AgentSessionHooks): () => void {
	hooksBySessionId.set(sessionId, hooks);
	return () => {
		if (hooksBySessionId.get(sessionId) === hooks) hooksBySessionId.delete(sessionId);
		liveAgentSessions.delete(sessionId);
	};
}

/** Exported for the regression check and the patched sendCustomMessage path. */
export function shouldSuppressTriggerTurnForSession(sessionId: string): boolean {
	return hooksBySessionId.get(sessionId)?.shouldSuppressTriggerTurn() ?? false;
}

/** Legacy single-session fallback. Prefer bindAgentSessionHooks(). */
export function setAgentAbortHandler(fn: AgentAbortHandler | null): void {
	fallbackAbortHandler = fn;
}

/** Legacy single-session fallback. Prefer bindAgentSessionHooks(). */
export function setTriggerTurnGuard(fn: (() => boolean) | null): void {
	fallbackTriggerTurnGuard = fn;
}

export function getLiveAgentSession(sessionId?: string): unknown {
	return sessionId ? liveAgentSessions.get(sessionId) ?? null : fallbackLiveAgentSession;
}

/** Test-only: drop captured sessions so the ctx.abort() fallback is exercised. */
export function resetLiveAgentSessionForTests(): void {
	liveAgentSessions.clear();
	fallbackLiveAgentSession = null;
}

export function onAgentAbort(sessionId?: string): void {
	const handler = sessionId ? hooksBySessionId.get(sessionId)?.onAbort : fallbackAbortHandler;
	if (!handler) return;
	try {
		handler();
	} catch {
		// a broken handler must not break the abort path
	}
}

const proto = AgentSession.prototype as unknown as {
	abort?: AbortFn & { __piGoalAbortHook?: boolean };
	sendCustomMessage?: SendCustomMessageFn & { __piGoalTriggerGuard?: boolean };
};

const origAbort = proto.abort;

if (typeof origAbort === "function" && !origAbort.__piGoalAbortHook) {
	const patched: AbortFn & { __piGoalAbortHook?: boolean } = function (this: unknown) {
		noteLiveAgentSession(this);
		onAgentAbort(sessionIdOf(this) ?? undefined);
		return origAbort.call(this);
	};
	patched.__piGoalAbortHook = true;
	proto.abort = patched;
}

/**
 * While the user stop is in effect, record custom messages but do not let them
 * wake that same session. Never consult another session's stop state.
 */
const origSendCustomMessage = proto.sendCustomMessage;

if (typeof origSendCustomMessage === "function" && !origSendCustomMessage.__piGoalTriggerGuard) {
	const patched: SendCustomMessageFn & { __piGoalTriggerGuard?: boolean } = async function (this: unknown, message, options) {
		noteLiveAgentSession(this);
		const sessionId = sessionIdOf(this);
		const suppress = sessionId
			? shouldSuppressTriggerTurnForSession(sessionId)
			: fallbackTriggerTurnGuard?.() ?? false;
		if (options?.triggerTurn && suppress) {
			return origSendCustomMessage.call(this, message, { ...options, triggerTurn: false });
		}
		return origSendCustomMessage.call(this, message, options);
	};
	patched.__piGoalTriggerGuard = true;
	proto.sendCustomMessage = patched;
}

/** No-op exported so the hook installs as a load side effect. */
export function installAgentAbortHook(): void {
	// patched at module load
}
