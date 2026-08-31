# pi-goal

![pi-goal](docs/assets/pi-goal-poster.png)

Persistent autonomous goals + built-in provider retry + background-aware continuation for [pi](https://github.com/badlogic/pi-mono) — one extension with a single autonomous-turn owner.

`pi-goal` adds a `/goal` command and goal tools so Pi can keep working toward a long-running, thread-scoped objective until the goal is complete, paused, cleared, or token-budget-limited. It also bundles the full `pi-retry` capability set (provider error retry, max-tokens continuation, empty-response recovery) and waits for background work (pi-background-tasks / pi-subagents) before continuing a goal.

> **Merged extension:** pi-goal now includes everything the standalone `pi-retry` extension provided. Do **not** install `pi-retry` alongside it — retry ships built in.

## Install

```bash
pi install npm:pi-goal
```

Or from git:

```bash
pi install git:github.com/Michaelliv/pi-goal
```

## Usage

```text
/goal improve benchmark coverage until the suite has strong evidence
/goal --tokens 50k finish the migration and verify tests
/goal
/goal status
/goal pause
/goal resume
/goal clear
/goal statusbar off
```

When a goal is active, the extension shows compact visible lifecycle markers like `Goal active` and `Goal continuing`; expand them with `ctrl+o` to inspect the objective and usage. The full continuation instructions ride along as the content of that custom message, so the model always has the objective and audit guidance in the transcript while the renderer keeps the visible UI compact.

The same Pi agent keeps running normal turns in the same session context until it calls `update_goal({ status: "complete" })`, the user pauses/clears it, or the token budget is reached. Reloading Pi pauses an active goal instead of silently resuming it; use `/goal resume` to continue.

## What it adds

- `pi-goal-writer` skill: draft and review strong `/goal` objectives with evidence-based success criteria
- `/goal [--tokens 50k] <objective>`: set or replace a goal
- `/goal` or `/goal status`: show the current goal
- `/goal pause`: stop autonomous continuation without deleting the goal
- `/goal resume`: reactivate a paused goal
- `/goal clear`: remove the goal
- `/goal statusbar on|off`: show or hide the footer status line
- `create_goal` tool: model can set or replace the current goal only when explicitly requested
- `get_goal` tool: read current goal state
- `update_goal` tool: model can only mark the goal `complete`
- `get_goal` and `update_goal` are only exposed to the model while a goal is `active`; paused, cleared, complete, and budget-limited goals hide them so unrelated sessions are not tempted to call them
- footer status: `Pursuing goal`, `Goal paused`, `Goal achieved`, or `Goal unmet`

## Flow

```text
/goal <objective>
  -> persist goal in the current Pi session
  -> show compact Goal marker and footer status
  -> deliver continuation instructions as the marker's message content
  -> trigger an agent turn
  -> account time/tokens on turn_end
  -> decide continuation only at the fully-settled boundary (agent_settled)
     after retries / compaction / queued follow-ups have all resolved
  -> stop when update_goal marks complete, user pauses/clears, or budget is hit
```

## Built-in retry

pi-goal includes the former [pi-retry](https://github.com/monotykamary/pi-retry) engine as an internal module — installing `pi-retry` separately is no longer needed and no longer recommended:

- every provider error is retried by default (`stopReason === "error"`), indefinitely, with exponential backoff `2s → 4s → 8s → … → capped at 60s`
- permanent failures are never retried: invalid API key, unknown model, suspended account
- quota / session-limit / budget exhaustion is a hard stop (fix billing or wait for the reset window, then `/retry`)
- HTTP 400/413, credit/payment transients, network / connection / timeout / socket errors all retry
- context-overflow errors defer to pi's compaction instead of blind retrying
- `stopReason === "length"` auto-continues without repeating content (uncapped — each chunk is real output)
- empty / thinking-only stops get exactly one recovery nudge per streak, then give up
- `/retry` (manual trigger), `/retry status` (diagnostics), `/retry reset` (clear counters)
- compatibility lifecycle events `pi-retry:started` / `pi-retry:completed` / `pi-retry:cancelled` with `retryId` correlation are still emitted
- while the merged engine is driving a recovery, pi's own bounded auto-retry steps aside (`_prepareRetry` guard) so the two engines never race into an unstoppable retry storm; if pi-goal is not driving, the builtin retry works exactly as before
- `Esc` during the idle backoff window cancels the pending recovery turn (raw terminal input hook, TUI mode) — a stop always works, even when no run is active
- if a standalone `pi-retry` also runs in the same process you get a one-time warning; disable it because retry is built in here

Retry and goal continuation share one **ContinuationCoordinator** — at most one automatic next-turn exists at any time. Priority order when requests collide:

```text
provider retry > max_tokens continuation > empty-response nudge
    > background wake > normal goal continuation > budget wrap-up
```

Goal `complete` / `pause` / `clear`, budget limits, session reloads, user input, and Esc aborts bump a generation counter that instantly invalidates every pending timer, retry, continuation, and background wake from the previous epoch — a completed goal can never be revived by a stale callback.

Note one behavioral difference vs standalone pi-retry: automatic recovery is suppressed while a goal exists in a non-active state (`paused`, `complete`, `cleared`, `budget_limited`) so nothing can silently resume it. Pure non-goal sessions keep full pi-retry behavior, and manual `/retry` always works.

## Background-aware goals

An agent may stop normally while background work is still running (a long test suite, a detached subagent). pi-goal treats that as **waiting**, not as completion:

- supported natively via public APIs: [`npm:pi-background-tasks`](https://www.npmjs.com/package/pi-background-tasks) (EventBus request/response + terminal events) and [`npm:pi-subagents`](https://www.npmjs.com/package/pi-subagents) (in-process RPC `status` → `fleet.totalActive`)
- **all tracked background work must settle** before a normal goal continuation is issued; one finished reviewer does not resume the goal while another is still running
- completion events are treated only as *signals*; the authoritative state comes from re-querying each provider's status snapshot
- if a plugin sends its own completion wake (e.g. `bg_run` with `triggerOnCompletion`), pi-goal detects the pending messages and stays quiet — no double wake
- a provider that cannot confirm its state (timeout, malformed reply) fails **closed**: unknown counts as “possibly still working”, never as idle
- neither plugin installed? both adapters degrade gracefully and goals continue immediately

### Wait timeout

A fallback inactivity timeout (default **15 minutes**) guards against lost terminal events or stuck registries. The timeout only means “no observable progress for a while”: it wakes the agent once to investigate —

> Background work has not produced a terminal state within the wait timeout. Re-check the outstanding background work and decide whether to keep waiting, inspect its status/logs, recover it, or continue other useful work. Do not assume the background work succeeded.

It never kills jobs, never marks them successful, and never completes the goal.

### Architecture

```text
                    Agent turn
                        |
                        v
                 classify outcome
                        |
      +-----------------+-----------------+
      |                 |                 |
    error             length          normal stop
      |                 |                 |
    retry           continuation           |
                                        Goal active?
                                          |
                             +------------+------------+
                             |                         |
                           no Goal                    Goal
                             |                         |
                            stop              background active?
                                                   |
                                      +------------+-----------+
                                      |                        |
                                     yes                       no
                                      |                        |
                                    WAIT                goal continue
                                      |
                              background terminal
                                          |
                              all providers idle?
                                          |
                                 +--------+--------+
                                 |                 |
                                no                yes
                                 |                 |
                               WAIT       existing wake pending?
                                                   |
                                           +-------+-------+
                                           |               |
                                          yes              no
                                           |               |
                                      let it wake    fallback wake
```

### Third-party background extensions

Other background plugins integrate through a lightweight process-local registry at `Symbol.for("pi-goal.background-work.v1")`. Register a provider from any extension (no import of pi-goal required):

```js
const key = Symbol.for("pi-goal.background-work.v1");
const reg = (globalThis[key] ??= { version: 1, providers: new Map() });
reg.providers.set("my-plugin", {
	name: "my-plugin",
	// Return { activeCount, activeIds, state: "known" | "unknown" } for this session.
	async getActiveWork(sessionId) {
		return { provider: "my-plugin", activeCount: myJobs.size, activeIds: [...myJobs.keys()], state: "known", checkedAt: Date.now() };
	},
	// Optional: call whenever state may have changed (wake signal only).
	subscribe(onChanged) { bus.on("my-plugin:done", onChanged); return () => bus.off("my-plugin:done", onChanged); },
});
```

Arbitrary third-party background extensions that expose **no** status API or provider registration cannot be tracked automatically — they require such an adapter/provider registration.

## Completion behavior

The model is instructed to audit completion against real evidence before calling `update_goal`. The `update_goal` tool deliberately accepts only `status: "complete"`; pausing, resuming, clearing, and budget limiting are controlled by the user or extension runtime. The final turn is still accounted even when the model completes the goal mid-turn.

## Configuration

Defaults preserve existing behavior; everything is tunable via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_GOAL_RETRY_ENABLED` | `true` | master switch for the built-in retry engine |
| `PI_GOAL_RETRY_BASE_DELAY_MS` | `2000` | first backoff delay |
| `PI_GOAL_RETRY_MAX_DELAY_MS` | `60000` | backoff cap |
| `PI_GOAL_BACKGROUND_ENABLED` | `true` | background-aware waiting |
| `PI_GOAL_BG_WAIT_TIMEOUT_MS` | `900000` (15 min) | fallback inactivity timeout while waiting |
| `PI_GOAL_BG_WAKE_GRACE_MS` | `1000` | debounce after the last terminal event before a fallback wake |
| `PI_GOAL_BG_QUERY_TIMEOUT_MS` | `3000` | per-provider status query timeout (fails closed) |
| `PI_GOAL_BG_PROBE_RETRY_DELAY_MS` | `300` | spacing between the two presence probes that decide "plugin absent" |

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"`. It follows the active session branch, survives reloads, and does not require an external database.

## License

MIT
