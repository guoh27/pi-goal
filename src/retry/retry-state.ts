/**
 * Retry state tracking, exponential backoff, and configuration for the retry
 * engine merged from guoh27/pi-retry.
 */

export interface BackoffConfig {
	baseDelayMs: number;
	maxDelayMs: number;
	multiplier: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	multiplier: 2,
};

/** Calculate delay with exponential backoff and cap (2s → 4s → 8s → ... → 60s). */
export function calculateDelay(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF_CONFIG): number {
	const delay = config.baseDelayMs * Math.pow(config.multiplier, Math.max(0, attempt - 1));
	return Math.min(delay, config.maxDelayMs);
}

/** Format a duration for display. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = ((ms % 60000) / 1000).toFixed(0);
	return `${minutes}m ${seconds}s`;
}

/**
 * Retry state manager for one error category. `attempt` counts consecutive
 * failures and feeds the backoff curve; it resets on success.
 */
export class RetryState {
	private attempt = 0;
	private isRetrying = false;
	private lastErrorMessage = "";

	getAttempt(): number {
		return this.attempt;
	}

	getIsRetrying(): boolean {
		return this.isRetrying;
	}

	getLastErrorMessage(): string {
		return this.lastErrorMessage;
	}

	startRetry(errorMessage: string): void {
		this.isRetrying = true;
		this.attempt++;
		this.lastErrorMessage = errorMessage;
	}

	endRetry(): void {
		this.isRetrying = false;
	}

	reset(): void {
		this.attempt = 0;
		this.isRetrying = false;
		this.lastErrorMessage = "";
	}

	succeed(): void {
		this.attempt = 0;
		this.isRetrying = false;
		this.lastErrorMessage = "";
	}
}

/**
 * State manager for max_tokens continuations. Uncapped by design — each
 * continuation produces valid output and the model terminates naturally.
 */
export class ContinuationState {
	private count = 0;
	private isContinuing = false;

	getCount(): number {
		return this.count;
	}

	getIsContinuing(): boolean {
		return this.isContinuing;
	}

	startContinuation(): void {
		this.isContinuing = true;
		this.count++;
	}

	endContinuation(): void {
		this.isContinuing = false;
	}

	/** Called when a turn completes normally; resets the streak counter. */
	complete(): void {
		this.count = 0;
		this.isContinuing = false;
	}

	reset(): void {
		this.count = 0;
		this.isContinuing = false;
	}
}

/** Runtime configuration resolved from environment variables with pi-retry defaults. */
export interface RetryEngineConfig {
	enabled: boolean;
	baseDelayMs: number;
	maxDelayMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
	if (value == null) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.round(parsed);
}

export function resolveRetryConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): RetryEngineConfig {
	return {
		enabled: env.PI_GOAL_RETRY_ENABLED !== "false" && env.PI_GOAL_RETRY_ENABLED !== "0",
		baseDelayMs: positiveInt(env.PI_GOAL_RETRY_BASE_DELAY_MS, DEFAULT_BACKOFF_CONFIG.baseDelayMs),
		maxDelayMs: positiveInt(env.PI_GOAL_RETRY_MAX_DELAY_MS, DEFAULT_BACKOFF_CONFIG.maxDelayMs),
	};
}
