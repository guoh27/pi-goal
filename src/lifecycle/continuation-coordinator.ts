/**
 * ContinuationCoordinator — the SINGLE autonomous next-turn owner for the
 * merged pi-goal extension.
 *
 * Every behaviour that starts a turn without the user asking for it (provider
 * retry, max_tokens continuation, empty-response nudge, goal continuation,
 * background completion/timeout wake) must be requested through this
 * coordinator. At most ONE autonomous turn is ever scheduled at a time, and
 * higher-priority requests displace lower-priority pending ones.
 *
 * Priority order (high → low):
 *   provider_retry > max_tokens_continue > empty_response_nudge
 *     > background_completion_wake / background_timeout_wake > goal_continue
 *
 * Generation / epoch invalidation: every scheduled action captures the current
 * generation. Goal complete/pause/clear, budget_limited, user input, user
 * abort, and session reset/reload bump the generation; every pending timer,
 * callback, and displaced intent from an older generation is dropped. Guards
 * are re-checked INSIDE the timer callback immediately before the send — not
 * only when the timer was created.
 */

export type AutonomousReason =
	| "provider_retry"
	| "max_tokens_continue"
	| "empty_response_nudge"
	| "budget_wrapup"
	| "goal_continue"
	| "background_completion_wake"
	| "background_timeout_wake";

const PRIORITY: Record<AutonomousReason, number> = {
	provider_retry: 50,
	max_tokens_continue: 40,
	empty_response_nudge: 30,
	budget_wrapup: 25,
	background_completion_wake: 20,
	background_timeout_wake: 20,
	goal_continue: 10,
};

export function priorityOf(reason: AutonomousReason): number {
	return PRIORITY[reason];
}

export interface ScheduledAction {
	reason: AutonomousReason;
	priority: number;
	generation: number;
	fireAt: number;
	timerId: unknown;
	execute: () => void;
}

/** Runtime phase of the autonomous lifecycle (never persisted; goal status stays authoritative). */
export type LifecyclePhase = "idle" | "running" | "retrying" | "continuing" | "waiting_for_background";

export interface CoordinatorOptions {
	now?: () => number;
	setTimeout?: (handler: () => void, ms: number) => unknown;
	clearTimeout?: (timerId: unknown) => void;
	/**
	 * Final gate invoked inside the timer right before `execute` runs.
	 * Return false to drop the action (stale generation, goal inactive,
	 * session changed, user interrupted, higher-priority work exists...).
	 */
	guard?: (action: { reason: AutonomousReason; generation: number }) => boolean;
	onEvent?: (event: CoordinatorEvent) => void;
}

export type CoordinatorEvent =
	| { type: "scheduled"; reason: AutonomousReason; delayMs: number; generation: number; displaced?: AutonomousReason }
	| { type: "fired"; reason: AutonomousReason; generation: number }
	| { type: "dropped"; reason: AutonomousReason; why: "stale-generation" | "guard-rejected"; generation: number }
	| { type: "displaced"; reason: AutonomousReason; by: AutonomousReason }
	| { type: "invalidated"; reason: string; count: number; generation: number };

export class ContinuationCoordinator {
	private generation = 1;
	private scheduled: ScheduledAction | null = null;
	private _phase: LifecyclePhase = "idle";
	private readonly now: () => number;
	private readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
	private readonly clearTimeoutFn: (timerId: unknown) => void;
	private guardFn: NonNullable<CoordinatorOptions["guard"]> | null = null;
	private onEventFn: CoordinatorOptions["onEvent"] | null = null;

	constructor(options: CoordinatorOptions = {}) {
		this.now = options.now ?? Date.now;
		this.setTimeoutFn = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
		this.clearTimeoutFn = options.clearTimeout ?? ((id) => clearTimeout(id as any));
		this.guardFn = options.guard ?? null;
		this.onEventFn = options.onEvent ?? null;
	}

	setGuard(guard: NonNullable<CoordinatorOptions["guard"]>): void {
		this.guardFn = guard;
	}

	setEventListener(listener: CoordinatorOptions["onEvent"]): void {
		this.onEventFn = listener;
	}

	getGeneration(): number {
		return this.generation;
	}

	getPhase(): LifecyclePhase {
		return this._phase;
	}

	setPhase(phase: LifecyclePhase): void {
		this._phase = phase;
	}

	getPending(): ScheduledAction | null {
		return this.scheduled;
	}

	hasPending(): boolean {
		return this.scheduled !== null;
	}

	isPending(reason: AutonomousReason): boolean {
		return this.scheduled?.reason === reason;
	}

	/**
	 * Bump the epoch and drop every pending action/callback belonging to the
	 * previous generation. Called on goal complete/pause/clear, budget_limited,
	 * user input, user abort, and session start/shutdown.
	 */
	invalidateAll(why: string): number {
		const invalidated = this.scheduled ? 1 : 0;
		if (this.scheduled) {
			this.clearTimeoutFn(this.scheduled.timerId);
			this.scheduled = null;
		}
		this.generation++;
		this._phase = "idle";
		this.emit({ type: "invalidated", reason: why, count: invalidated, generation: this.generation });
		return invalidated;
	}

	/**
	 * Request an autonomous next turn.
	 *
	 * - No pending action → occupy the slot and arm the timer.
	 * - Pending lower-priority action → displace it (the displaced intent is
	 *   re-derived after the higher-priority action settles, because every
	 *   settle re-runs the decision procedure).
	 * - Pending same-or-higher-priority action → ignored (single-owner rule).
	 */
	requestTurn(request: { reason: AutonomousReason; delayMs?: number; execute: () => void }): boolean {
		if (!Number.isFinite(request.delayMs) || (request.delayMs ?? 0) < 0) request.delayMs = 0;
		const delayMs = request.delayMs ?? 0;
		const priority = PRIORITY[request.reason];

		if (this.scheduled) {
			if (this.scheduled.priority >= priority) {
				return false; // keep the first/higher-priority owner
			}
			const displaced = this.scheduled.reason;
			this.clearTimeoutFn(this.scheduled.timerId);
			this.emit({ type: "displaced", reason: displaced, by: request.reason });
			this.schedule(request.reason, priority, delayMs, request.execute, displaced);
			return true;
		}

		this.schedule(request.reason, priority, delayMs, request.execute);
		return true;
	}

	private schedule(
		reason: AutonomousReason,
		priority: number,
		delayMs: number,
		execute: () => void,
		displaced?: AutonomousReason,
	): void {
		const generation = this.generation;
		const fireAt = this.now() + delayMs;
		const timerId = this.setTimeoutFn(() => {
			// Only the currently-registered slot may fire; anything stale is dropped.
			if (!this.scheduled || this.scheduled.timerId !== timerId) return;
			const action = this.scheduled;
			this.scheduled = null;

			// Re-validate at FIRE time — never trust the checks made at schedule time.
			if (action.generation !== this.generation) {
				this.emit({ type: "dropped", reason: action.reason, why: "stale-generation", generation: action.generation });
				return;
			}
			if (this.guardFn && !this.guardFn({ reason: action.reason, generation: action.generation })) {
				this.emit({ type: "dropped", reason: action.reason, why: "guard-rejected", generation: action.generation });
				return;
			}
			this.emit({ type: "fired", reason: action.reason, generation: action.generation });
			action.execute();
		}, delayMs);

		this.scheduled = { reason, priority, generation, fireAt, timerId, execute };
		this.emit({ type: "scheduled", reason, delayMs, generation, displaced });
		void fireAt;
	}

	/** Manually cancel the pending action without bumping the generation. */
	cancelPending(): boolean {
		if (!this.scheduled) return false;
		this.clearTimeoutFn(this.scheduled.timerId);
		this.scheduled = null;
		return true;
	}

	private emit(event: CoordinatorEvent): void {
		try {
			this.onEventFn?.(event);
		} catch {
			// listener errors must never break scheduling
		}
	}
}
