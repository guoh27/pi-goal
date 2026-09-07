/**
 * GoalController — the decision procedure that sits on top of the
 * ContinuationCoordinator, the RetryEngine, and the BackgroundWorkManager.
 *
 * It implements the stopReason → action matrix from the design spec:
 *
 *   no goal            normal→STOP · retryable→RETRY · permanent→STOP
 *                      length→CONTINUE · empty→NUDGE ONCE
 *   goal active        normal→GOAL CONTINUE (after background check)
 *                      retryable→RETRY ONLY · length→CONTINUE ONLY
 *                      empty→NUDGE ONLY · permanent/quota→halt+notify+pause
 *   goal + background  normal stop with active/unknown background work →
 *                      WAITING_FOR_BACKGROUND (no goal continuation)
 *   goal inactive      everything invalidated; nothing may revive the goal
 *
 * Every autonomous send goes through the coordinator — this class never calls
 * sendMessage directly outside a coordinator-executed callback.
 */

import type { AggregatedSnapshot, BackgroundWorkManager } from "../background/manager.ts";
import type { ContinuationCoordinator } from "./continuation-coordinator.ts";
import { RetryEngine, type ClassifiedOutcome, type RecoveryPlan } from "../retry/retry-engine.ts";

export interface GoalControllerConfig {
	backgroundEnabled: boolean;
	waitTimeoutMs: number;
	wakeGraceMs: number;
	/** Per-query timeout for provider status calls (fail-closed on expiry). */
	queryTimeoutMs: number;
	/** Delay between the two presence probes that decide "plugin absent". */
	probeRetryDelayMs: number;
}

export const DEFAULT_GOAL_CONTROLLER_CONFIG: GoalControllerConfig = {
	backgroundEnabled: true,
	waitTimeoutMs: 15 * 60 * 1000,
	wakeGraceMs: 1000,
	queryTimeoutMs: 3000,
	probeRetryDelayMs: 300,
};

function positiveInt(value: string | undefined, fallback: number): number {
	if (value == null) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.round(parsed);
}

export function resolveGoalControllerConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): GoalControllerConfig {
	const base = { ...DEFAULT_GOAL_CONTROLLER_CONFIG };
	if (env.PI_GOAL_BACKGROUND_ENABLED === "false" || env.PI_GOAL_BACKGROUND_ENABLED === "0") base.backgroundEnabled = false;
	base.waitTimeoutMs = positiveInt(env.PI_GOAL_BG_WAIT_TIMEOUT_MS, base.waitTimeoutMs);
	base.wakeGraceMs = positiveInt(env.PI_GOAL_BG_WAKE_GRACE_MS, base.wakeGraceMs);
	base.queryTimeoutMs = positiveInt(env.PI_GOAL_BG_QUERY_TIMEOUT_MS, base.queryTimeoutMs);
	base.probeRetryDelayMs = positiveInt(env.PI_GOAL_BG_PROBE_RETRY_DELAY_MS, base.probeRetryDelayMs);
	return base;
}

/** Narrow surface of the extension the controller drives (injectable for tests). */
export interface GoalControllerHost {
	/** Send the hidden provider-valid user turn that starts the recovery. */
	sendTrigger(content: string): void;
	/** Send the visible goal continuation prompt. */
	sendGoalContinuation(): void;
	/** Remove a trailing error assistant message from live agent state before retrying. */
	removeTrailingErrorFromAgentState(): void;
	isGoalActive(): boolean;
	/** True when a goal object exists in ANY state (active/paused/complete/budget_limited). */
	isGoalPresent(): boolean;
	hasPendingMessages(): boolean;
	isAgentBusy(): boolean;
	getSessionId(): string | null;
	notify(level: "info" | "warning" | "error", text: string): void;
	/** Pause the active goal because the auto-loop must halt (permanent error). */
	pauseGoalForHalt(reason: string): void;
	now?: () => number;
	setTimeout?: (handler: () => void, ms: number) => unknown;
	clearTimeout?: (timerId: unknown) => void;
}

export type WaitState = "not_waiting" | "waiting_for_background";

interface WaitingEpoch {
	id: number;
	timerId: unknown;
	startedAt: number;
	lastActivityAt: number;
	timeoutWakeSent: boolean;
	activeIdsAtEntry: string[];
}

export const BACKGROUND_TIMEOUT_WAKE_CONTENT =
	"Background work has not produced a terminal state within the wait timeout. " +
	"Re-check the outstanding background work and decide whether to keep waiting, " +
	"inspect its status/logs, recover it, or continue other useful work. " +
	"Do not assume the background work succeeded.";

export class GoalController {
	private readonly coordinator: ContinuationCoordinator;
	private readonly engine: RetryEngine;
	private readonly background: BackgroundWorkManager | null;
	private readonly config: GoalControllerConfig;
	private readonly host: GoalControllerHost;

	private suppressNextGoalContinue = false;
	private waitState: WaitState = "not_waiting";
	private waitingEpoch: WaitingEpoch | null = null;
	private waitingEpochCounter = 0;
	private lastBackgroundEventAt = 0;
	private graceTimer: unknown = null;
	private disposers: Array<() => void> = [];
	private readonly now: () => number;
	private readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
	private readonly clearTimeoutFn: (timerId: unknown) => void;

	constructor(options: {
		coordinator: ContinuationCoordinator;
		engine: RetryEngine;
		background: BackgroundWorkManager | null;
		config?: Partial<GoalControllerConfig>;
		host: GoalControllerHost;
	}) {
		this.coordinator = options.coordinator;
		this.engine = options.engine;
		this.background = options.background;
		this.config = { ...DEFAULT_GOAL_CONTROLLER_CONFIG, ...(options.config ?? {}) };
		this.host = options.host;
		this.now = options.host.now ?? Date.now;
		this.setTimeoutFn = options.host.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
		this.clearTimeoutFn = options.host.clearTimeout ?? ((id) => clearTimeout(id as any));

		if (this.background) {
			const unsubscribe = this.background.subscribeAll(() => this.onBackgroundSignal());
			this.disposers.push(unsubscribe);
		}
	}

	getWaitState(): WaitState {
		return this.waitState;
	}

	/** Public passthrough so the extension layer can send hidden recovery turns (manual /retry). */
	sendRecoveryTrigger(content: string): void {
		this.host.sendTrigger(content);
	}

	/** Public reset used on session start: clears waiting state without touching the coordinator. */
	clearWaitState(): void {
		this.exitWaiting("session-reset");
	}

	/**
	 * Cancel every pending autonomous turn (coordinator slot + grace timer)
	 * WITHOUT leaving the background wait state — used by the Esc handler so a
	 * stop never silently kills the goal's wake-up chain; /goal pause is the
	 * explicit way to do that.
	 */
	cancelPendingTurns(): void {
		this.coordinator.cancelPending();
		if (this.graceTimer != null) {
			this.clearTimeoutFn(this.graceTimer);
			this.graceTimer = null;
		}
	}

	getWaitingEpoch(): Readonly<WaitingEpoch> | null {
		return this.waitingEpoch;
	}

	getLastBackgroundEventAt(): number {
		return this.lastBackgroundEventAt;
	}

	/**
	 * Handle a finished agent run: classify the outcome and route recovery
	 * through the coordinator. Called from `agent_end`. Returns the outcome.
	 */
	handleAgentEnd(lastAssistantMessage: unknown, aborted: boolean): ClassifiedOutcome {
		if (aborted) {
			this.engine.noteAbort();
			this.coordinator.invalidateAll("user-abort");
			this.exitWaiting("user-abort");
			return { kind: "aborted" };
		}
		const outcome = this.engine.classify(lastAssistantMessage);
		switch (outcome.kind) {
			case "normal":
				this.engine.noteSuccess();
				// A genuine normal stop is a SUCCESS and ends the recovery story:
				// drop any recovery turn still pending from an earlier failure (e.g. a
				// provider_retry timer armed before a compaction-continued run settled
				// successfully). "Retry the previous request." must never fire after a
				// run the model actually completed. Goal continuation is unaffected —
				// it is decided fresh at settle() with nothing pending.
				this.coordinator.cancelPending(
					(reason) => reason === "provider_retry" || reason === "max_tokens_continue" || reason === "empty_response_nudge",
				);
				return outcome; // continuation decision happens at settle()
			case "none":
			case "aborted":
				return outcome;
			default:
				this.routeRecovery(outcome);
				return outcome;
		}
	}

	private routeRecovery(outcome: ClassifiedOutcome): void {
		// A goal that exists in a non-active state (complete/paused/cleared/
		// budget_limited) suppresses automatic recovery entirely so nothing can
		// revive it. Pure non-goal sessions keep full pi-retry behavior.
		if (this.host.isGoalPresent() && !this.host.isGoalActive()) {
			this.suppressNextGoalContinue = true;
			return;
		}

		const plan: RecoveryPlan = this.engine.planRecovery(outcome);
		switch (plan.action) {
			case "retry": {
				this.suppressNextGoalContinue = false;
				const scheduled = this.coordinator.requestTurn({
					reason: "provider_retry",
					delayMs: plan.delayMs,
					execute: () => {
						this.host.removeTrailingErrorFromAgentState();
						if (plan.triggerContent) this.host.sendTrigger(plan.triggerContent);
					},
				});
				if (scheduled) {
					this.coordinator.setPhase("retrying");
					if (plan.notify) this.host.notify(plan.notify.level, plan.notify.text);
				}
				return;
			}
			case "continue": {
				const scheduled = this.coordinator.requestTurn({
					reason: "max_tokens_continue",
					delayMs: plan.delayMs,
					execute: () => {
						if (plan.triggerContent) this.host.sendTrigger(plan.triggerContent);
					},
				});
				if (scheduled) {
					this.coordinator.setPhase("continuing");
					if (plan.notify) this.host.notify(plan.notify.level, plan.notify.text);
				}
				return;
			}
			case "nudge": {
				const scheduled = this.coordinator.requestTurn({
					reason: "empty_response_nudge",
					delayMs: plan.delayMs,
					execute: () => {
						if (plan.triggerContent) this.host.sendTrigger(plan.triggerContent);
					},
				});
				if (scheduled) {
					this.coordinator.setPhase("continuing");
					if (plan.notify) this.host.notify(plan.notify.level, plan.notify.text);
				}
				return;
			}
			case "halt_goal_notify": {
				// Permanent / quota error: never loop the goal. Notify, pause an
				// active goal, and suppress any queued continuation.
				this.suppressNextGoalContinue = true;
				if (this.host.isGoalActive()) this.host.pauseGoalForHalt(plan.errorMessage ?? "non-retryable error");
				if (plan.notify) this.host.notify(plan.notify.level, plan.notify.text);
				this.coordinator.invalidateAll("goal-halted");
				return;
			}
			case "defer_compaction": {
				// Context overflow: pi core compacts and retries inside its own run;
				// do not stack our own turn on top of it this settle.
				this.suppressNextGoalContinue = true;
				if (plan.notify) this.host.notify(plan.notify.level, plan.notify.text);
				return;
			}
			case "stop":
			default: {
				// Empty-stop give-up: do not nudge again and do not goal-continue
				// into another empty turn.
				if (outcome.kind === "empty_stop") this.suppressNextGoalContinue = true;
				if (plan.notify) this.host.notify(plan.notify.level, plan.notify.text);
				return;
			}
		}
	}

	/**
	 * The fully-settled boundary: no automatic retry, compaction, or queued
	 * continuation will run after this point. Decides between goal
	 * continuation and background waiting. Idempotent per run.
	 */
	async settle(): Promise<void> {
		// A recovery action already owns the next turn.
		if (this.coordinator.hasPending()) return;
		if (!this.host.isGoalActive()) {
			this.coordinator.setPhase("idle");
			return;
		}
		if (this.host.hasPendingMessages()) return;

		if (this.suppressNextGoalContinue) {
			this.suppressNextGoalContinue = false;
			return;
		}

		// Background-aware waiting: normal stop with outstanding background work
		// must NOT be read as goal completion.
		if (this.config.backgroundEnabled && this.background) {
			const snapshot = await this.background.snapshot(this.host.getSessionId() ?? "");
			const waiting = snapshot.totalActive > 0 || snapshot.anyUnknown;
			if (waiting) {
				this.enterWaiting(snapshot);
				return;
			}
		}

		this.exitWaiting("all-idle");
		this.coordinator.setPhase("continuing");
		this.coordinator.requestTurn({
			reason: "goal_continue",
			delayMs: 0,
			execute: () => {
				this.coordinator.setPhase("running");
				this.host.sendGoalContinuation();
			},
		});
	}

	/** Change signal from a background provider. Signal only — re-query to confirm. */
	private onBackgroundSignal(): void {
		this.lastBackgroundEventAt = this.now();
		if (this.waitState !== "waiting_for_background") return;
		if (this.waitingEpoch) this.waitingEpoch.lastActivityAt = this.lastBackgroundEventAt;

		// Debounce: the background plugin may already deliver its own wake
		// (bg_run triggerOnCompletion). Wait out the grace window, then re-query.
		if (this.graceTimer != null) this.clearTimeoutFn(this.graceTimer);
		const epoch = this.waitingEpoch;
		const generation = this.coordinator.getGeneration();
		this.graceTimer = this.setTimeoutFn(() => {
			this.graceTimer = null;
			void this.evaluateAfterGrace(epoch?.id ?? -1, generation);
		}, this.config.wakeGraceMs);
	}

	private async evaluateAfterGrace(epochId: number, generation: number): Promise<void> {
		if (generation !== this.coordinator.getGeneration()) return;
		if (this.waitState !== "waiting_for_background") return;
		if (epochId !== -1 && this.waitingEpoch?.id !== epochId) return;
		if (!this.host.isGoalActive()) return;

		if (!this.background) return;
		const snapshot = await this.background.snapshot(this.host.getSessionId() ?? "");
		const stillBusy = snapshot.totalActive > 0 || snapshot.anyUnknown;

		if (stillBusy) {
			// Not done yet (e.g. reviewer B still running): keep waiting and
			// re-arm the inactivity timeout epoch on state change.
			if (this.waitingEpoch) this.waitingEpoch.lastActivityAt = this.now();
			return;
		}

		// All known providers idle. If something else already queued a wake
		// (the background plugin's own follow-up), let it win.
		if (this.host.hasPendingMessages() || this.host.isAgentBusy() || this.coordinator.hasPending()) return;

		this.exitWaiting("all-providers-idle");
		this.coordinator.setPhase("continuing");
		this.coordinator.requestTurn({
			reason: "background_completion_wake",
			delayMs: 0,
			execute: () => {
				this.coordinator.setPhase("running");
				this.host.sendGoalContinuation();
			},
		});
	}

	private enterWaiting(snapshot: AggregatedSnapshot): void {
		this.waitState = "waiting_for_background";
		this.coordinator.setPhase("waiting_for_background");
		// Every entry from settle() means "the agent stopped again while work is
		// still outstanding" — that starts a FRESH timeout epoch (new id, new
		// timer, wake budget reset), per the design spec. This also guarantees a
		// live timer always exists while waiting.
		const previous = this.waitingEpoch;
		if (previous) this.clearTimeoutFn(previous.timerId);
		const id = ++this.waitingEpochCounter;
		const startedAt = this.now();
		const generation = this.coordinator.getGeneration();
		const timerId = this.setTimeoutFn(() => {
			void this.onWaitTimeout(id, generation);
		}, this.config.waitTimeoutMs);
		this.waitingEpoch = { id, timerId, startedAt, lastActivityAt: startedAt, timeoutWakeSent: false, activeIdsAtEntry: [...snapshot.activeIds] };
	}

	private exitWaiting(why: string): void {
		void why;
		if (this.waitingEpoch) {
			this.clearTimeoutFn(this.waitingEpoch.timerId);
			this.waitingEpoch = null;
		}
		if (this.graceTimer != null) {
			this.clearTimeoutFn(this.graceTimer);
			this.graceTimer = null;
		}
		this.waitState = "not_waiting";
	}

	private async onWaitTimeout(epochId: number, generation: number): Promise<void> {
		if (generation !== this.coordinator.getGeneration()) return;
		if (this.waitingEpoch?.id !== epochId) return;
		if (!this.host.isGoalActive()) {
			this.exitWaiting("goal-inactive");
			return;
		}
		if (!this.background) return;

		// True inactivity semantics: the timeout means "no observable state
		// change for a full window". If a background signal arrived recently
		// (e.g. task A finished while B keeps running), just continue the wait
		// for the remaining time instead of waking the agent.
		const idleForMs = this.now() - this.waitingEpoch.lastActivityAt;
		if (idleForMs < this.config.waitTimeoutMs) {
			this.rearmWaitTimeout(epochId, this.config.waitTimeoutMs - idleForMs);
			return;
		}

		// Re-query all providers: the timeout only means "no observable change
		// for a long time", never "tasks finished".
		const snapshot = await this.background.snapshot(this.host.getSessionId() ?? "");
		const stillBusy = snapshot.totalActive > 0 || snapshot.anyUnknown;

		if (!stillBusy) {
			if (this.host.hasPendingMessages() || this.host.isAgentBusy() || this.coordinator.hasPending()) return;
			this.exitWaiting("all-providers-idle");
			this.coordinator.setPhase("continuing");
			this.coordinator.requestTurn({
				reason: "background_completion_wake",
				delayMs: 0,
				execute: () => {
					this.coordinator.setPhase("running");
					this.host.sendGoalContinuation();
				},
			});
			return;
		}

		// Still busy / unknown: fall back wake the agent ONCE per epoch so it
		// can investigate. Never mark tasks complete, never kill them.
		if (this.waitingEpoch.timeoutWakeSent) {
			// Re-arm once more rather than spamming wakes; the agent's next stop
			// with changed ids opens a fresh epoch anyway.
			this.rearmWaitTimeout(epochId);
			return;
		}
		this.waitingEpoch.timeoutWakeSent = true;
		if (this.host.hasPendingMessages() || this.coordinator.hasPending()) {
			this.rearmWaitTimeout(epochId);
			return;
		}
		this.coordinator.requestTurn({
			reason: "background_timeout_wake",
			delayMs: 0,
			execute: () => {
				this.coordinator.setPhase("running");
				this.host.sendTrigger(BACKGROUND_TIMEOUT_WAKE_CONTENT);
			},
		});
	}

	private rearmWaitTimeout(epochId: number, delayMs?: number): void {
		const current = this.waitingEpoch;
		if (!current || current.id !== epochId) return;
		this.clearTimeoutFn(current.timerId);
		const generation = this.coordinator.getGeneration();
		current.timerId = this.setTimeoutFn(() => {
			void this.onWaitTimeout(epochId, generation);
		}, Math.max(1, delayMs ?? this.config.waitTimeoutMs));
	}

	/** Invalidate every pending schedule/timer because the goal stopped being active. */
	invalidate(why: string): void {
		this.suppressNextGoalContinue = false;
		this.coordinator.invalidateAll(why);
		this.exitWaiting(why);
	}

	dispose(): void {
		for (const dispose of this.disposers.splice(0)) {
			try {
				dispose();
			} catch {
				// ignore
			}
		}
		this.exitWaiting("dispose");
	}
}
