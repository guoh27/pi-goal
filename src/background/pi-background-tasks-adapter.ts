/**
 * Adapter for npm:pi-background-tasks using ONLY its public EventBus API:
 *
 *   request  channel: pi-background-tasks:request:v1
 *   response channel: pi-background-tasks:response:v1
 *   terminal channel: pi-background-tasks:terminal:v1
 *
 * - `status` operation returns `{ tasks: BgTaskSnapshot[] }`; tasks with
 *   status === "running" are active.
 * - `capabilities` probes whether the plugin is present at all.
 * - Terminal events are used purely as change SIGNALS; the status snapshot is
 *   authoritative and is re-queried after every signal.
 * - Any timeout / malformed response fails CLOSED (state "unknown").
 *
 * Session scoping note: the EventBus is process-local, so all tasks visible
 * here belong to this Pi process. Tasks that were already running when a
 * session boundary (/new, resume, fork) occurred are retired by
 * `markSessionBoundary()` so an old session's work cannot block the new one.
 */

import type { BackgroundWorkProvider, BackgroundWorkSnapshot } from "./types.ts";

export const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

interface BgTaskSnapshotLike {
	id?: unknown;
	status?: unknown;
}

interface BgResponseLike {
	request_id?: unknown;
	ok?: unknown;
	result?: unknown;
	error?: unknown;
}

interface BgTerminalLike {
	task?: BgTaskSnapshotLike;
}

let requestCounter = 0;

function nextRequestId(): string {
	requestCounter += 1;
	return `pi-goal-bg-${Date.now().toString(36)}-${requestCounter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class PiBackgroundTasksAdapter implements BackgroundWorkProvider {
	readonly name = "pi-background-tasks";

	private readonly events: EventBusLike;
	private readonly queryTimeoutMs: number;
	private readonly probeRetryDelayMs: number;
	private disposers: Array<() => void> = [];
	private listeners = new Set<() => void>();
	private presence: "unprobed" | "present" | "absent" = "unprobed";
	private failedProbes = 0;
	/** Task ids that were running at a session boundary; excluded from this session's active count. */
	private retiredTaskIds = new Set<string>();

	constructor(events: EventBusLike, options?: { queryTimeoutMs?: number; probeRetryDelayMs?: number }) {
		this.events = events;
		this.queryTimeoutMs = options?.queryTimeoutMs ?? 3000;
		this.probeRetryDelayMs = options?.probeRetryDelayMs ?? 300;
		this.subscribeToTerminal();
		// Eager presence probe: decide "installed?" early so an ABSENT plugin
		// never blocks goal continuation. Two spaced probes decide absence;
		// once proven present, failures fail closed (state unknown) instead.
		void this.probePresence().then((present) => {
			if (!present && this.presence !== "absent") {
				setTimeout(() => void this.probePresence(), this.probeRetryDelayMs);
			}
		});
	}

	getAvailable(): boolean {
		if (this.presence === "present") return true;
		if (this.presence === "absent") return false;
		return true; // unprobed: assume possibly-present until a probe decides
	}

	markSessionBoundary(activeTaskIds: Iterable<string>): void {
		for (const id of activeTaskIds) this.retiredTaskIds.add(id);
	}

	async getActiveWork(_sessionId: string): Promise<BackgroundWorkSnapshot> {
		const result = await this.request("status", {});
		if (!result.ok) {
			this.noteProbeFailure();
			return { provider: this.name, activeCount: 0, activeIds: [], state: "unknown", checkedAt: Date.now() };
		}
		this.presence = "present";
		this.failedProbes = 0;

		const tasks = this.extractTasks(result.value);
		const activeIds: string[] = [];
		for (const task of tasks) {
			if (!isRecord(task)) continue;
			if (task.status !== "running") continue;
			const id = typeof task.id === "string" ? task.id : null;
			if (id == null || this.retiredTaskIds.has(id)) continue;
			activeIds.push(id);
		}
		return { provider: this.name, activeCount: activeIds.length, activeIds, state: "known", checkedAt: Date.now() };
	}

	/** Probe capabilities once; flips presence to absent only after repeated failures. */
	async probePresence(): Promise<boolean> {
		const result = await this.request("capabilities", {});
		if (result.ok) {
			this.presence = "present";
			this.failedProbes = 0;
			return true;
		}
		this.noteProbeFailure();
		return this.presence === "present";
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

	private subscribeToTerminal(): void {
		const unsubscribe = this.events.on(BG_TERMINAL_CHANNEL, (data) => {
			// Signal only — dedupe/re-query happens in the goal layer.
			const terminal = data as BgTerminalLike | undefined;
			const taskId = terminal?.task?.id;
			if (typeof taskId === "string") this.retiredTaskIds.delete(taskId);
			for (const listener of [...this.listeners]) {
				try {
					listener();
				} catch {
					// listener errors must not break the bus
				}
			}
		});
		if (typeof unsubscribe === "function") this.disposers.push(unsubscribe);
	}

	private noteProbeFailure(): void {
		this.failedProbes += 1;
		if (this.failedProbes >= 2 && this.presence !== "present") {
			// Two consecutive dead queries and no proof of life → not installed
			// (or gone). Excluded from snapshots instead of blocking forever.
			this.presence = "absent";
		}
	}

	private extractTasks(result: unknown): BgTaskSnapshotLike[] {
		if (Array.isArray(result)) return result as BgTaskSnapshotLike[];
		if (isRecord(result) && Array.isArray((result as { tasks?: unknown }).tasks)) {
			return (result as { tasks: BgTaskSnapshotLike[] }).tasks;
		}
		return [];
	}

	private request(operation: "status" | "capabilities", payload: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown }> {
		return new Promise((resolve) => {
			let settled = false;
			const requestId = nextRequestId();
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
				const off = this.events.on(BG_RESPONSE_CHANNEL, (data) => {
					const response = data as BgResponseLike | undefined;
					if (!isRecord(response) || response.request_id !== requestId) return;
					if (response.ok !== true) finish({ ok: false });
					else finish({ ok: true, value: response.result });
				});
				unsubscribe = typeof off === "function" ? off : undefined;

				this.events.emit(BG_REQUEST_CHANNEL, {
					schema_version: BG_REQUEST_SCHEMA,
					request_id: requestId,
					operation,
					payload,
				});
			} catch {
				// The captured bus is stale after session replacement/reload and
				// throws on use — fail closed instead of an unhandled rejection.
				finish({ ok: false });
			}
		});
	}
}
