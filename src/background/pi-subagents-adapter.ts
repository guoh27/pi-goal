/**
 * Adapter for npm:pi-subagents using ONLY its public in-process RPC:
 *
 *   request channel: subagents:rpc:v1:request
 *   reply channel:   subagents:rpc:v1:reply:<requestId>
 *   ready channel:   subagents:rpc:v1:ready
 *
 * - `status` reply carries `fleet.totalActive` — the authoritative count of
 *   active children (foreground + async/workflow) owned by THIS session.
 * - `subagent:async-complete` / `subagent:process-terminal` events are used
 *   purely as change SIGNALS. One completion event never means "all work
 *   done" (reviewer A done, reviewer B still running) — the status snapshot
 *   is re-queried and only totalActive === 0 counts as idle.
 * - Timeout / malformed reply fails CLOSED (state "unknown").
 * - Presence: the ready event marks presence permanently; before that,
 *   two consecutive timed-out probes mark the plugin absent (graceful
 *   degradation when pi-subagents is not installed).
 */

import type { BackgroundWorkProvider, BackgroundWorkSnapshot } from "./types.ts";

export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";

const RPC_PROTOCOL_VERSION = 1;

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

interface RpcReplyLike {
	version?: unknown;
	requestId?: unknown;
	success?: unknown;
	data?: unknown;
	error?: unknown;
}

interface FleetStatusLike {
	totalActive?: unknown;
	entries?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

let requestCounter = 0;

function nextRequestId(): string {
	requestCounter += 1;
	return `pi-goal-sa-${Date.now().toString(36)}-${requestCounter}`;
}

export class PiSubagentsAdapter implements BackgroundWorkProvider {
	readonly name = "pi-subagents";

	private readonly events: EventBusLike;
	private readonly queryTimeoutMs: number;
	private readonly probeRetryDelayMs: number;
	private disposers: Array<() => void> = [];
	private listeners = new Set<() => void>();
	private presence: "unprobed" | "present" | "absent" = "unprobed";
	private failedProbes = 0;

	constructor(events: EventBusLike, options?: { queryTimeoutMs?: number; probeRetryDelayMs?: number }) {
		this.events = events;
		this.queryTimeoutMs = options?.queryTimeoutMs ?? 3000;
		this.probeRetryDelayMs = options?.probeRetryDelayMs ?? 300;

		const offReady = this.events.on(SUBAGENT_RPC_READY_EVENT, () => {
			this.presence = "present";
			this.failedProbes = 0;
		});
		if (typeof offReady === "function") this.disposers.push(offReady);

		const signal = () => {
			for (const listener of [...this.listeners]) {
				try {
					listener();
				} catch {
					// listener errors must not break the bus
				}
			}
		};
		for (const channel of [SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_PROCESS_TERMINAL_EVENT]) {
			const off = this.events.on(channel, signal);
			if (typeof off === "function") this.disposers.push(off);
		}

		// Eager presence probe: a status reply proves presence even if the ready
		// event fired before we subscribed; two spaced dead probes mark it absent.
		void this.getActiveWork("probe").then((snapshot) => {
			if (snapshot.state === "known" && snapshot.activeCount > 0) {
				for (const listener of [...this.listeners]) listener();
			} else if (this.presence !== "present" && this.presence !== "absent") {
				setTimeout(() => void this.getActiveWork("probe"), this.probeRetryDelayMs);
			}
		});
	}

	getAvailable(): boolean {
		if (this.presence === "present") return true;
		if (this.presence === "absent") return false;
		return true; // unprobed: assume possibly-present until a probe decides
	}

	async getActiveWork(_sessionId: string): Promise<BackgroundWorkSnapshot> {
		const result = await this.request("status", {});
		if (!result.ok || !isRecord(result.value)) {
			this.noteProbeFailure();
			return { provider: this.name, activeCount: 0, activeIds: [], state: "unknown", checkedAt: Date.now() };
		}
		this.presence = "present";
		this.failedProbes = 0;

		const value = result.value as { fleet?: unknown };
		const fleet = (isRecord(value.fleet) ? value.fleet : {}) as FleetStatusLike;
		const totalActiveRaw = fleet.totalActive;
		const totalActive = typeof totalActiveRaw === "number" && Number.isFinite(totalActiveRaw) ? Math.max(0, Math.floor(totalActiveRaw)) : 0;
		const entries = Array.isArray(fleet.entries) ? fleet.entries : [];
		const activeIds: string[] = [];
		for (const entry of entries.slice(0, totalActive)) {
			if (isRecord(entry) && typeof entry.key === "string") activeIds.push(entry.key);
		}
		// totalActive may exceed the bounded entries window; ids stay bounded but the count is authoritative.
		return { provider: this.name, activeCount: totalActive, activeIds, state: "known", checkedAt: Date.now() };
	}

	subscribe(onChanged: () => void): () => void {
		this.listeners.add(onChanged);
		return () => this.listeners.delete(onChanged);
	}

	dispose(): void {
		for (const dispose of this.disposers.splice(0)) {
			try {
				dispose();
			} catch {
				// ignore
			}
		}
		this.listeners.clear();
	}

	private noteProbeFailure(): void {
		this.failedProbes += 1;
		if (this.failedProbes >= 2 && this.presence !== "present") {
			this.presence = "absent";
		}
	}

	private request(method: "status", params: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown }> {
		return new Promise((resolve) => {
			let settled = false;
			const requestId = nextRequestId();
			const replyChannel = `subagents:rpc:v1:reply:${requestId}`;
			// `let` before `finish`: a synchronously-invoked handler must never
			// read `unsubscribe` in its TDZ.
			let unsubscribe: (() => void) | undefined;
			const finish = (value: { ok: boolean; value?: unknown }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe?.();
				resolve(value);
			};

			const timer = setTimeout(() => finish({ ok: false }), this.queryTimeoutMs);
			try {
				const off = this.events.on(replyChannel, (data) => {
					const reply = data as RpcReplyLike | undefined;
					if (!isRecord(reply) || reply.requestId !== requestId) return;
					if (reply.version !== RPC_PROTOCOL_VERSION) return finish({ ok: false });
					if (reply.success !== true) finish({ ok: false });
					else finish({ ok: true, value: reply.data });
				});
				unsubscribe = typeof off === "function" ? off : undefined;

				this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
					version: RPC_PROTOCOL_VERSION,
					requestId,
					method,
					params,
					source: { extension: "pi-goal" },
				});
			} catch {
				// The captured bus is stale after session replacement/reload and
				// throws on use — fail closed instead of an unhandled rejection.
				finish({ ok: false });
			}
		});
	}
}
