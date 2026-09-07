const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const patterns = jiti("../../src/retry/error-patterns.ts");

function errMsg(text) {
	return { role: "assistant", stopReason: "error", errorMessage: text, content: [] };
}

test("retryable errors: connection / credit / 400-413 / 5xx are all retried", () => {
	const samples = [
		"Connection error.",
		"fetch failed",
		"socket hang up",
		"ECONNRESET",
		"ETIMEDOUT",
		"dns lookup failed",
		"Max outbound streams is 100, 100 open",
		"400 status code with no body",
		"Bad Request: malformed payload",
		"413 status code (payload too large)",
		"not enough credits to run this request",
		"402 status code. Payment required.",
		"500 status code. Internal server error",
		"service unavailable (503)",
		"some completely unknown provider hiccup",
	];
	for (const text of samples) {
		assert.equal(patterns.hasRetryableError(errMsg(text)), true, `expected retryable: ${text}`);
	}
});

test("permanent failures are not retried", () => {
	const samples = [
		"Invalid API key provided",
		"model not found: gpt-9",
		"No such model exists",
		"unsupported model for this endpoint",
	];
	for (const text of samples) {
		assert.equal(patterns.hasRetryableError(errMsg(text)), false, `expected permanent: ${text}`);
		assert.equal(patterns.isNonRetryableError(errMsg(text)), true);
	}
});

test("quota/session-limit/budget exhaustion is a hard stop", () => {
	const samples = [
		"You've hit your usage limit · resets 4pm (Asia/Kuala_Lumpur)",
		"You've hit your ChatGPT usage limit (plus plan). Try again in ~5330 min.",
		"usage_limit_reached",
		"You exceeded your current quota, please check your plan and billing details",
		"Rate limit exceeded: free-models-per-day",
		"Budget has been exceeded! Current cost: $1, Max budget: $1",
		"You have exhausted your capacity on this model. Your quota will reset after 8h44m7s.",
		"Insufficient balance or no resource package. Please recharge.",
		"Your account org<ak> is suspended, please check your plan and billing details",
	];
	for (const text of samples) {
		assert.equal(patterns.hasQuotaExhaustedError(errMsg(text)), true, `expected quota: ${text}`);
		assert.equal(patterns.hasRetryableError(errMsg(text)), false);
	}
});

test("per-minute rate limits and pay-as-you-go balance errors stay retryable", () => {
	assert.equal(patterns.hasQuotaExhaustedError(errMsg("429 Too Many Requests, slow down")), false);
	assert.equal(patterns.hasRetryableError(errMsg("429 Too Many Requests, slow down")), true);
	assert.equal(patterns.hasQuotaExhaustedError(errMsg("Insufficient Balance in your wallet")), false);
	assert.equal(patterns.hasCreditError(errMsg("Insufficient credits on account")), true);
});

test("provider type-token and ChatGPT-plan usage limits are quota (no retry spam)", () => {
	const samples = [
		// JSON envelopes whose bodies may not even mention a limit
		'429: {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 7 days. To continue using this model now, enable usage from your available balance"}',
		'429: {"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit"}',
		// ChatGPT / Codex plan phrasing
		"Codex error: The usage limit has been reached",
		"You have reached your usage limit for ChatGPT Plus",
		"usage limit hit, try again in ~60 min.",
	];
	for (const text of samples) {
		assert.equal(patterns.hasQuotaExhaustedError(errMsg(text)), true, `expected quota: ${text}`);
		assert.equal(patterns.hasRetryableError(errMsg(text)), false, `expected non-retryable: ${text}`);
	}
});

test("parseResetWindowMs extracts the stated reset window", () => {
	const MIN = 60_000;
	const cases = [
		["You have hit your ChatGPT usage limit (plus plan). Try again in ~135 min.", 135 * MIN],
		["You have hit your ChatGPT usage limit (plus plan). Try again in ~117 min.", 117 * MIN],
		["usage limit hit, try again in ~2 hours", 2 * 3600_000],
		["please retry after 90 minutes", 90 * MIN],
		["Monthly usage limit reached. Resets in 7 days.", 7 * 24 * 3600_000],
		["5-hour usage limit reached", 5 * 3600_000],
	];
	for (const [text, expected] of cases) {
		assert.equal(patterns.parseResetWindowMs(text), expected, `expected ${expected}ms for: ${text}`);
	}
	const none = [
		"usage_limit_reached",
		"too many requests, try again in 20 seconds",
		"You have hit your usage limit · resets 4pm (Asia/Kuala_Lumpur)",
		'429: {"type":"FreeUsageLimitError","message":"Console upstream refused"}',
		"",
	];
	for (const text of none) {
		assert.equal(patterns.parseResetWindowMs(text), null, `expected no window for: ${text}`);
	}
});

test("context overflow defers to compaction instead of retrying", () => {
	const overflow = [
		"prompt is too long: 250000 tokens > 200000 maximum",
		"input is too long for requested model",
		"request_too_large",
		"exceeds the context window",
		"maximum context length is 200000 tokens",
		"too many tokens",
	];
	for (const text of overflow) {
		assert.equal(patterns.isContextOverflowError(errMsg(text)), true, `expected overflow: ${text}`);
	}
	// Throttling that merely looks like overflow stays retryable.
	assert.equal(
		patterns.isContextOverflowError(errMsg("Throttling error: rate limited")),
		false,
	);
});

test("silenced errors neither retry nor notify", () => {
	const msg = errMsg("cannot continue from message role");
	assert.equal(patterns.isSilencedError(msg), true);
	assert.equal(patterns.isNonRetryableError(msg), true);
});

test("max tokens and empty stops are recognized as non-error outcomes", () => {
	assert.equal(patterns.hasMaxTokensStop({ role: "assistant", stopReason: "length", content: [] }), true);
	assert.equal(patterns.hasEmptyStop({ role: "assistant", stopReason: "stop", content: [] }), true);
	assert.equal(
		patterns.hasEmptyStop({ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "..." }] }),
		true,
	);
	assert.equal(
		patterns.hasEmptyStop({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "" }] }),
		true,
	);
	assert.equal(patterns.hasMaxTokensStop({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }), false);
	assert.equal(patterns.hasEmptyStop({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] }), false);
	assert.equal(patterns.hasEmptyStop({ role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "1" }] }), false);
});
