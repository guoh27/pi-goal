/**
 * Retry/recovery engine merged from guoh27/pi-retry.
 *
 * The engine is PURE: given the latest assistant outcome it classifies the
 * outcome and plans the recovery action (with backoff delay). It never sends
 * messages and owns no timers — scheduling goes through the lifecycle
 * ContinuationCoordinator so there is exactly one autonomous-turn owner.
 */

import {
	getErrorCategory,
	has400or413Error,
	hasConnectionError,
	hasCreditError,
	hasEmptyStop,
	hasMaxTokensStop,
	hasQuotaExhaustedError,
	hasRetryableError,
	isAssistantMessage,
	isContextOverflowError,
	isNonRetryableError,
	isSilencedError,
	parseResetWindowMs,
	type AssistantMessageLike,
	type ErrorCategory,
} from "./error-patterns.ts";
import {
	calculateDelay,
	ContinuationState,
	DEFAULT_BACKOFF_CONFIG,
	DEFAULT_QUOTA_WAIT_MAX_MS,
	DEFAULT_QUOTA_WAIT_MAX_ROUNDS,
	formatDuration,
	resolveRetryConfig,
	RetryState,
	type BackoffConfig,
	type RetryEngineConfig,
} from "./retry-state.ts";

export type OutcomeKind =
	| "none"
	| "normal"
	| "aborted"
	| "error_retryable"
	| "error_permanent"
	| "error_quota"
	| "error_overflow"
	| "length"
	| "empty_stop";

export type RecoveryAction =
	| "retry"
	| "continue"
	| "nudge"
	/** permanent/quota error while a goal is active: stop the auto loop, notify, pause the goal */
	| "halt_goal_notify"
	/** context overflow: defer to pi core compaction, do nothing ourselves */
	| "defer_compaction"
	/** nothing to do */
	| "stop";

export interface ClassifiedOutcome {
	kind: OutcomeKind;
	category?: ErrorCategory;
	errorMessage?: string;
}

export interface RecoveryPlan extends ClassifiedOutcome {
	action: RecoveryAction;
	delayMs: number;
	attempt?: number;
	/** Content for the hidden provider-valid user turn that drives the recovery. */
	triggerContent?: string;
	notify?: { level: "info" | "warning" | "error"; text: string };
}

/** Max empty/thinking-only nudges per streak (bounded by design, like upstream). */
export const MAX_EMPTY_CONTINUATIONS = 1;

const RETRY_TRIGGER_CONTENT = "Retry the previous request.";
const CONTINUE_TRIGGER_CONTENT = "Continue exactly where you left off without repeating content.";
const EMPTY_NUDGE_CONTENT =
	"Your previous turn contained only thinking and no answer or text. Continue now and produce the actual response, using tools if needed.";

export class RetryEngine {
	private readonly config: RetryEngineConfig;
	private readonly backoff: BackoffConfig;
	private readonly state400 = new RetryState();
	private readonly stateCredit = new RetryState();
	private readonly stateConnection = new RetryState();
	private readonly stateOther = new RetryState();
	private readonly stateQuotaWait = new RetryState();
	private readonly stateContinuation = new ContinuationState();
	private readonly stateEmptyStop = new ContinuationState();

	constructor(config: RetryEngineConfig = resolveRetryConfig()) {
		// Spread over full defaults so partial config injection (tests) cannot
		// leave undefined timing fields behind.
		this.config = {
			enabled: true,
			baseDelayMs: DEFAULT_BACKOFF_CONFIG.baseDelayMs,
			maxDelayMs: DEFAULT_BACKOFF_CONFIG.maxDelayMs,
			quotaWaitMaxMs: DEFAULT_QUOTA_WAIT_MAX_MS,
			quotaWaitMaxRounds: DEFAULT_QUOTA_WAIT_MAX_ROUNDS,
			...(config as Partial<RetryEngineConfig>),
		};
		this.backoff = { baseDelayMs: this.config.baseDelayMs, maxDelayMs: this.config.maxDelayMs, multiplier: DEFAULT_BACKOFF_CONFIG.multiplier };
	}

	getConfig(): RetryEngineConfig {
		return { ...this.config };
	}

	/** Classify the latest assistant message without mutating any counters. */
	classify(message: unknown): ClassifiedOutcome {
		if (!isAssistantMessage(message)) return { kind: "none" };
		const msg = message as AssistantMessageLike;
		if (msg.stopReason === "aborted") return { kind: "aborted" };
		if (msg.stopReason === "length") return { kind: "length" };
		if (msg.stopReason === "error") {
			const errorMessage = msg.errorMessage ?? "";
			if (isContextOverflowError(msg)) return { kind: "error_overflow", errorMessage };
			if (hasQuotaExhaustedError(msg)) return { kind: "error_quota", errorMessage, category: "quota" };
			if (!hasRetryableError(msg)) return { kind: "error_permanent", errorMessage, category: getErrorCategory(errorMessage) };
			return { kind: "error_retryable", errorMessage, category: getErrorCategory(errorMessage) };
		}
		if (msg.stopReason === "stop" && hasEmptyStop(msg)) return { kind: "empty_stop" };
		return { kind: "normal" };
	}

	/** True when the last classified outcome was an error worth surfacing in diagnostics. */
	lastCategoryFor(kind: "400-413" | "credit" | "connection" | "other"): RetryState {
		switch (kind) {
			case "400-413":
				return this.state400;
			case "credit":
				return this.stateCredit;
			case "connection":
				return this.stateConnection;
			default:
				return this.stateOther;
		}
	}

	getContinuationCount(): number {
		return this.stateContinuation.getCount();
	}

	getEmptyStopCount(): number {
		return this.stateEmptyStop.getCount();
	}

	/** Consecutive windowed usage-limit waits scheduled so far (reset on success/abort). */
	getQuotaWaitCount(): number {
		return this.stateQuotaWait.getAttempt();
	}

	/**
	 * Plan the recovery action for a classified outcome. Mutates the internal
	 * streak counters exactly once per planned action.
	 */
	planRecovery(outcome: ClassifiedOutcome): RecoveryPlan {
		switch (outcome.kind) {
			case "normal":
			case "none":
				// A genuine normal stop is a SUCCESS, never a retry target: the model
				// completed its turn, so "Retry the previous request." must not follow.
				return { ...outcome, action: "stop", delayMs: 0 };
			case "length": {
				this.stateContinuation.startContinuation();
				const plan: RecoveryPlan = {
					...outcome,
					action: "continue",
					delayMs: 0,
					attempt: this.stateContinuation.getCount(),
					triggerContent: CONTINUE_TRIGGER_CONTENT,
				};
				this.stateContinuation.endContinuation();
				return plan;
			}
			case "empty_stop": {
				if (this.stateEmptyStop.getCount() >= MAX_EMPTY_CONTINUATIONS) {
					return {
						...outcome,
						action: "stop",
						delayMs: 0,
						notify: {
							level: "warning",
							text: `Empty response after ${this.stateEmptyStop.getCount()} continuation(s) - giving up (model keeps ending the turn with no output).`,
						},
					};
				}
				this.stateEmptyStop.startContinuation();
				const plan: RecoveryPlan = {
					...outcome,
					action: "nudge",
					delayMs: 0,
					attempt: this.stateEmptyStop.getCount(),
					triggerContent: EMPTY_NUDGE_CONTENT,
				};
				this.stateEmptyStop.endContinuation();
				return plan;
			}
			case "error_retryable": {
				const state = this.stateForCategory(outcome.category);
				state.startRetry(outcome.errorMessage ?? "Unknown error");
				state.endRetry();
				const attempt = state.getAttempt();
				const delayMs = calculateDelay(attempt, this.backoff);
				return {
					...outcome,
					action: "retry",
					delayMs,
					attempt,
					triggerContent: RETRY_TRIGGER_CONTENT,
					notify: {
						level: "info",
						text: `${categoryLabel(outcome.category)} error — retry attempt ${attempt} (backoff ${formatDuration(delayMs)})...`,
					},
				};
			}
			case "error_quota": {
				const errorMessage = outcome.errorMessage ?? "";
				// Quota errors that name a reset window ("Try again in ~135 min.",
				// "resets in ~2 hours") make immediate backoff pointless: every retry
				// fails until the window passes. Schedule ONE retry at the reset time
				// instead of either spamming short retries or halting instantly.
				const windowMs = parseResetWindowMs(errorMessage);
				if (windowMs != null && windowMs <= this.config.quotaWaitMaxMs) {
					this.stateQuotaWait.startRetry(errorMessage);
					const attempt = this.stateQuotaWait.getAttempt();
					this.stateQuotaWait.endRetry();
					if (attempt > this.config.quotaWaitMaxRounds) {
						this.stateQuotaWait.reset();
						return {
							...outcome,
							action: "halt_goal_notify",
							delayMs: 0,
							notify: {
								level: "error",
								text: `Still usage-limited after ${this.config.quotaWaitMaxRounds} scheduled wait(s) — giving up on the auto loop. Wait out the limit or fix the plan/billing, then /retry: ${errorMessage.substring(0, 100)}`,
							},
						};
					}
					return {
						...outcome,
						action: "retry",
						delayMs: windowMs,
						attempt,
						triggerContent: RETRY_TRIGGER_CONTENT,
						notify: {
							level: "info",
							text: `Usage limit hit — immediate retries would keep failing. Waiting ${formatDuration(windowMs)} until the stated reset window, then retrying once (round ${attempt}/${this.config.quotaWaitMaxRounds}).`,
						},
					};
				}
				return {
					...outcome,
					action: "halt_goal_notify",
					delayMs: 0,
					notify: {
						level: "error",
						text: `Quota/limit exhausted — not retrying (fix plan/billing or wait for the reset window, then /retry): ${errorMessage.substring(0, 100)}`,
					},
				};
			}
			case "error_permanent": {
				if (isSilencedError({ role: "assistant", stopReason: "error", errorMessage: outcome.errorMessage })) {
					return { ...outcome, action: "stop", delayMs: 0 };
				}
				return {
					...outcome,
					action: "halt_goal_notify",
					delayMs: 0,
					notify: {
						level: "error",
						text: `Non-retryable error (not retried): ${(outcome.errorMessage ?? "").substring(0, 100)}`,
					},
				};
			}
			case "error_overflow": {
				return {
					...outcome,
					action: "defer_compaction",
					delayMs: 0,
					notify: {
						level: "info",
						text: "Context overflow — deferring to compaction (auto-retry after compact).",
					},
				};
			}
			default:
				return { ...outcome, action: "stop", delayMs: 0 };
		}
	}

	/** A successful (usable) turn resets every streak, mirroring upstream pi-retry. */
	noteSuccess(): void {
		this.state400.succeed();
		this.stateCredit.succeed();
		this.stateConnection.succeed();
		this.stateOther.succeed();
		this.stateQuotaWait.succeed();
		this.stateContinuation.complete();
		this.stateEmptyStop.complete();
	}

	/** User cancellation resets streaks so they don't leak across branches. */
	noteAbort(): void {
		this.state400.reset();
		this.stateCredit.reset();
		this.stateConnection.reset();
		this.stateOther.reset();
		this.stateQuotaWait.reset();
		this.stateContinuation.endContinuation();
		this.stateEmptyStop.endContinuation();
	}

	resetAll(): void {
		this.noteSuccess();
		this.stateEmptyStop.reset();
	}

	private stateForCategory(category: ErrorCategory | undefined): RetryState {
		switch (category) {
			case "400-413":
				return this.state400;
			case "credit":
				return this.stateCredit;
			case "connection":
				return this.stateConnection;
			default:
				return this.stateOther;
		}
	}
}

function categoryLabel(category: ErrorCategory | undefined): string {
	switch (category) {
		case "400-413":
			return "400/413";
		case "credit":
			return "Credit";
		case "connection":
			return "Connection";
		case "builtin":
			return "Server";
		case "quota":
			return "Usage limit";
		default:
			return "Other";
	}
}
