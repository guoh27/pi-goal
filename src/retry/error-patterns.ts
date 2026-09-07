/**
 * Error pattern matching for the retry engine merged from guoh27/pi-retry
 * (upstream: monotykamary/pi-retry).
 *
 * Philosophy: retry EVERY provider error by default. The only skips are a tiny
 * blacklist of known permanent failures (invalid API key, missing model, ...)
 * and hard-stop quota/session-limit/budget exhaustion. Quota errors that name
 * a reset window ("Try again in ~135 min.") are NOT skipped: the engine
 * schedules ONE retry at the reset time. Everything else — 400s, connection
 * issues, credit errors, stream exhaustion, provider hiccups, unknown errors —
 * is retried with backoff.
 *
 * Context-overflow errors are NOT retried here: a hidden retry would resend
 * the same oversized context and overflow again. Pi core detects overflow,
 * compacts, and retries with reduced context; we defer to that path.
 */

/** Structural subset of an assistant message we rely on (keeps this module dependency-free). */
export interface AssistantMessageLike {
	role: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

// ── Specific pattern groups (used for categorisation / messaging) ──

const ERROR_400_413_PATTERNS = [
	/\b4(00|13)\b.*status code/i,
	/bad request/i,
	/payload too large/i,
];

const CREDIT_ERROR_PATTERNS = [
	/not enough credits/i,
	/insufficient credits/i,
	/insufficient balance/i,
	/out of credits/i,
	/payment required/i,
	/\b402\b.*status code/i,
];

export const CONNECTION_ERROR_PATTERNS = [
	/connection\s*error/i,
	/network\s*error/i,
	/fetch\s*failed/i,
	/socket\s*(hang\s*up|error|timeout)/i,
	/econnreset/i,
	/econnrefused/i,
	/etimedout/i,
	/enotfound/i,
	/dns\s*lookup\s*failed/i,
	/request\s*ended\s*without\s*sending\s*any\s*chunks/i,
	/upstream\s*connect/i,
	/other\s*side\s*closed/i,
	/reset\s*before\s*headers/i,
	/broken\s*pipe/i,
	/unexpected\s*end\s*of\s*file/i,
	/tls\s*handshake\s*(error|timeout)/i,
	/ssl\s*connection\s*error/i,
	/timeout\s*(awaiting|waiting\s*for)\s*response/i,
	/request\s*timeout/i,
	// Stream exhaustion (e.g. "Max outbound streams is 100, 100 open")
	/max outbound streams/i,
	/streams?\s*(exhausted|limit)/i,
];

// Patterns handled by pi's built-in retry — used for categorisation only
const BUILTIN_HANDLED_PATTERNS = [
	/overloaded/i,
	/rate\s*limit/i,
	/too\s*many\s*requests/i,
	/429/i,
	/5\d{2}/,
	/service\s*unavailable/i,
	/server\s*error/i,
	/internal\s*error/i,
	/retry\s*delay/i,
];

// Context-overflow error patterns. Mirrors pi-core's OVERFLOW_PATTERNS in
// @earendil-works/pi-ai/dist/utils/overflow.js so that the retry engine defers
// to compaction exactly when pi-core's _checkCompaction will detect overflow
// and compact + retry. Kept in sync manually — pi-ai is not a dependency.
//
// Why these are NOT retried: a hidden retry turn would re-send the same
// oversized context, so it overflows again → infinite loop. pi-core instead
// compacts and retries once; with static compaction that reliably reduces
// context, so the single retry succeeds.
const OVERFLOW_ERROR_PATTERNS = [
	/prompt is too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

// Patterns that look like overflow but are actually rate limiting / throttling.
// Mirrors pi-core's NON_OVERFLOW_PATTERNS. Excluded from overflow detection so
// throttling errors are still retried (they are not context-size problems).
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i,
	/rate limit/i,
	/too many requests/i,
];

// ── Blacklist: errors that are truly permanent and should NOT be retried ──

const NON_RETRYABLE_PATTERNS = [
	/invalid\s*api\s*key/i,
	/invalid\s*authentication/i,
	/api\s*key\s*(not\s*found|missing|revoked)/i,
	/model\s*not\s*found/i,
	/unknown\s*model/i,
	/no\s*such\s*model/i,
	/model\s*does\s*not\s*exist/i,
	/unsupported\s*model/i,
	/cannot continue from message role/i,
];

// Errors that are non-retryable AND should be silently ignored (no notification)
const SILENCED_PATTERNS = [/cannot continue from message role/i];

// Quota / session-limit / budget exhaustion — hard stops: retrying is pointless
// until the user upgrades, tops up a budget, or waits out a reset window
// measured in hours/days. Distinct from per-minute rate limits and pay-as-you-go
// balance errors, which stay retryable. See upstream pi-retry for the full
// evidence list of real provider messages matched here.
export const QUOTA_EXHAUSTED_PATTERNS = [
	// Provider error-type markers inside JSON envelopes, e.g.
	// `429: {"type":"GoUsageLimitError","message":"..."}` (opencode/codex/console
	// gateways) — the message body may not contain any quota phrasing at all.
	/(?:go|free)usagelimiterror/i,
	// Session / usage limits with reset windows (Claude, Codex, ChatGPT plans)
	/hit your (?:[a-z]+ )?usage limit/i,
	/hit your limit/i,
	/usage_limit_reached/i,
	/usage\s*limit\s*(?:has\s*been\s*)?(?:reached|hit|exceeded)/i,
	/reached (?:your|the) (?:chatgpt|codex|openai|api\s*)?usage limit/i,
	/hour\s*limit\s*reached/i,
	/limit\s*will\s*reset\s*at/i,
	/session\s*(limit|quota)/i,
	/exceeded your usage limit/i,
	// Billing / plan quotas (OpenAI insufficient_quota, Gemini RESOURCE_EXHAUSTED)
	/insufficient[_\s]quota/i,
	/exceeded your current quota/i,
	// Hard allotments
	/free.models.per.day/i,
	/allocated\s*quota/i,
	/premium\s*request\s*allowance/i,
	/monthly\s*(limit|quota|budget|allowance)/i,
	// Budget exhaustion (LiteLLM and similar proxies/gateways)
	/out of budget/i,
	/budget\s*(has\s*been\s*)?(exceeded|exhausted|limit)/i,
	/max(imum)?\s*budget\s*(exceeded|reached|limit)/i,
	/spending\s*limit/i,
	// Google subscription caps (Gemini Code Assist, Antigravity)
	/exhausted your capacity/i,
	/quota will reset after/i,
	/reached the quota limit/i,
	/you can resume using this model/i,
	// z.ai / GLM Coding Plan window exhaustion (429 code 1113)
	/no resource package/i,
	// Suspended accounts (Kimi exceeded_current_quota_error suspended form)
	/account\b[^.]*\bis\s*suspended/i,
	// Generic
	/quota\s*(exhausted|depleted)/i,
];

// ── Type guards ──

export function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	return Boolean(message) && typeof message === "object" && (message as AssistantMessageLike).role === "assistant";
}

/**
 * Parse a reset window out of quota/limit error text, e.g.
 * "Try again in ~135 min.", "resets in ~2 hours", "5-hour usage limit reached",
 * "Resets in 7 days.". Returns the window in ms, or null when the text names no
 * usable window (callers then treat the quota error as a plain hard stop).
 * Seconds and bare "4pm" style times deliberately do NOT match — waiting is
 * only worthwhile for hour-scale windows that providers state explicitly.
 */
export function parseResetWindowMs(errorMessage: string): number | null {
	if (!errorMessage) return null;
	const text = errorMessage;
	// "try again in ~135 min" / "resets in ~2 hours" / "retry after 90 minutes" / "Resets in 7 days"
	const match =
		/(?:again|reset|resets|retry|wait|until|in|after|within)\b[^.;\n]{0,40}?~?\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i.exec(text) ??
		// "5-hour usage limit" / "3-hour reset window"
		/(\d+(?:\.\d+)?)\s*-\s*(minutes?|hours?|days?)\b/i.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2].toLowerCase();
	const factor = unit.startsWith("day") ? 24 * 3600_000 : unit.startsWith("hour") || unit.startsWith("hr") ? 3600_000 : 60_000;
	return Math.round(value * factor);
}

function errorTextOf(message: AssistantMessageLike): string | null {
	if (message.stopReason !== "error" || !message.errorMessage) return null;
	return message.errorMessage;
}

// ── Specific category checks (for diagnostics / messaging) ──

export function has400or413Error(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = errorTextOf(message);
	if (text == null) return false;
	return ERROR_400_413_PATTERNS.some((p) => p.test(text));
}

export function hasCreditError(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = errorTextOf(message);
	if (text == null) return false;
	return CREDIT_ERROR_PATTERNS.some((p) => p.test(text));
}

export function hasConnectionError(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = errorTextOf(message);
	if (text == null) return false;
	return CONNECTION_ERROR_PATTERNS.some((p) => p.test(text));
}

/**
 * True for an error assistant message whose errorMessage indicates a
 * context-overflow (input exceeded the model's context window).
 * Callers should treat a true result as "defer to compaction, do NOT retry".
 */
export function isContextOverflowError(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = errorTextOf(message);
	if (text == null) return false;
	if (NON_OVERFLOW_PATTERNS.some((p) => p.test(text))) return false;
	return OVERFLOW_ERROR_PATTERNS.some((p) => p.test(text));
}

// ── Universal retry check ──

/** True for ANY assistant message with stopReason === "error" except the permanent-failure blacklist. */
export function hasRetryableError(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return !isNonRetryableError(message);
}

/** True only for known permanent failures (invalid API key, missing model, quota exhaustion, ...). */
export function isNonRetryableError(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = errorTextOf(message);
	if (text == null) return false;
	return (
		NON_RETRYABLE_PATTERNS.some((p) => p.test(text)) ||
		QUOTA_EXHAUSTED_PATTERNS.some((p) => p.test(text))
	);
}

/**
 * True for quota / session-limit / budget exhaustion errors where retrying is
 * pointless until the user acts. Deliberately NOT matched: per-minute rate
 * limits (429s) and pay-as-you-go balance errors — those stay retryable so a
 * mid-session top-up auto-resumes.
 */
export function hasQuotaExhaustedError(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = errorTextOf(message);
	if (text == null) return false;
	return QUOTA_EXHAUSTED_PATTERNS.some((p) => p.test(text));
}

/** True for errors that are non-retryable and should be silently ignored. */
export function isSilencedError(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = errorTextOf(message);
	if (text == null) return false;
	return SILENCED_PATTERNS.some((p) => p.test(text));
}

// ── Categorisation (for UI messages / diagnostics) ──

export type ErrorCategory = "400-413" | "credit" | "connection" | "builtin" | "quota" | "other";

export function getErrorCategory(errorMessage: string): ErrorCategory {
	if (QUOTA_EXHAUSTED_PATTERNS.some((p) => p.test(errorMessage))) return "quota";
	if (ERROR_400_413_PATTERNS.some((p) => p.test(errorMessage))) return "400-413";
	if (CREDIT_ERROR_PATTERNS.some((p) => p.test(errorMessage))) return "credit";
	if (CONNECTION_ERROR_PATTERNS.some((p) => p.test(errorMessage))) return "connection";
	if (BUILTIN_HANDLED_PATTERNS.some((p) => p.test(errorMessage))) return "builtin";
	return "other";
}

// ── Max tokens (not an error — continuation) ──

export function hasMaxTokensStop(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	return message.stopReason === "length";
}

// ── Empty / think-only stop (not an error — one-shot recovery nudge) ──

function getContentBlocks(message: AssistantMessageLike): unknown[] {
	const content = message.content;
	return Array.isArray(content) ? content : [];
}

/**
 * True for an assistant message whose turn ended without any USABLE output:
 * stopReason "stop" with zero blocks, or only reasoning/blank blocks.
 * "Usable" = a non-empty text block or a toolCall block. Does NOT flag a
 * legitimately text-only final answer.
 */
export function hasEmptyStop(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	if (message.stopReason !== "stop") return false;
	const hasUsable = getContentBlocks(message).some((block) => {
		if (!block || typeof block !== "object") return false;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "toolCall") return true;
		if (candidate.type === "text") {
			return typeof candidate.text === "string" && candidate.text.trim().length > 0;
		}
		return false;
	});
	return !hasUsable;
}
