/**
 * Builtin retry guard — prevents pi's own bounded retry from racing the
 * merged retry engine.
 *
 * Problem (observed in a real run): after agent_end with a retryable error,
 * pi's session runs `_prepareRetry` (up to 3 attempts) AND the pi-goal
 * engine schedules its own recovery at the same time. The two engines
 * interleave: pi's loop grabs the follow-up queued by pi-goal, both keep
 * seeing errors, and neither the 3-attempt cap nor the user's Esc can stop
 * the cycle — the user sees "Retry the previous request." repeating forever.
 *
 * Fix (same technique as upstream pi-retry): while the pi-goal recovery
 * engine owns the next turn (a recovery action is pending or the phase is
 * retrying/continuing), `_prepareRetry` returns false so pi's builtin retry
 * steps aside. pi-goal's engine is uncapped/exponential and fully respects
 * Esc/abort/user input, so nothing is lost. When pi-goal is NOT driving,
 * pi's builtin retry works exactly as before.
 */

import { AgentSession } from "@earendil-works/pi-coding-agent";

/** Returns true while the merged engine owns the recovery path. */
export type RecoveryActivityCheck = () => boolean;

let recoveryActive: RecoveryActivityCheck = () => false;

export function setRecoveryActivityCheck(check: RecoveryActivityCheck | null): void {
	recoveryActive = check ?? (() => false);
}

export function isRecoveryDriving(): boolean {
	return recoveryActive();
}

type PrepareRetryFn = (this: unknown, message: unknown) => Promise<boolean>;

const proto = AgentSession.prototype as unknown as {
	_prepareRetry?: PrepareRetryFn & { __piGoalRetryGuard?: boolean };
};

const origPrepareRetry = proto._prepareRetry;

if (typeof origPrepareRetry === "function" && !origPrepareRetry.__piGoalRetryGuard) {
	const patched: PrepareRetryFn & { __piGoalRetryGuard?: boolean } = function (this: unknown, message: unknown) {
		if (isRecoveryDriving()) {
			return Promise.resolve(false);
		}
		return origPrepareRetry.call(this, message);
	};
	patched.__piGoalRetryGuard = true;
	proto._prepareRetry = patched;
}

/** No-op exported so the guard is installed as a side effect of module load (asserted in tests). */
export function installBuiltinRetryGuard(): void {
	// patched at module load; kept as an explicit call site for clarity
}