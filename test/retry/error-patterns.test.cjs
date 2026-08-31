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
