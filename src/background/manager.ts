/**
 * BackgroundWorkManager — aggregates the built-in adapters and any
 * third-party providers registered in the open registry
 * (`Symbol.for("pi-goal.background-work.v1")`).
 *
 * Built-in adapters stay session-local because pi-web hosts multiple sessions
 * with distinct EventBus instances in one process. The open registry is only
 * for third-party providers.
 *
 * Fail-closed: a provider query that times out or returns malformed data
 * yields state "unknown", which the goal layer treats like active work.
 */

import { PiBackgroundTasksAdapter } from "./pi-background-tasks-adapter.ts";
import { PiSubagentsAdapter } from "./pi-subagents-adapter.ts";
import { PiWebSubagentsAdapter, type JournalEntriesProvider } from "./pi-web-subagents-adapter.ts";
import {
	listBackgroundWorkProviders,
	snapshotAllProviders,
	type BackgroundWorkProvider,
	type BackgroundWorkSnapshot,
} from "./types.ts";

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

export interface AggregatedSnapshot {
	snapshots: BackgroundWorkSnapshot[];
	totalActive: number;
	activeIds: string[];
	/** true when at least one present provider could not confirm its state */
	anyUnknown: boolean;
	/** true when at least one provider is installed/probed-present */
	hasProviders: boolean;
}

export class BackgroundWorkManager {
	readonly bgTasks: PiBackgroundTasksAdapter;
	readonly subagents: PiSubagentsAdapter;
	readonly webSubagents: PiWebSubagentsAdapter | null;
	/** Active ids from the most recent snapshot (used for session-boundary retirement). */
	lastActiveIds: string[] = [];

	constructor(
		events: EventBusLike,
		options?: { queryTimeoutMs?: number; probeRetryDelayMs?: number },
		getEntries?: JournalEntriesProvider,
	) {
		this.bgTasks = new PiBackgroundTasksAdapter(events, options);
		this.subagents = new PiSubagentsAdapter(events, options);
		this.webSubagents = getEntries ? new PiWebSubagentsAdapter(getEntries) : null;
	}

	/**
	 * Subscribe change signals from every currently-known provider plus both
	 * built-in adapters. Returns a disposer. Late-registered third-party
	 * providers still participate in snapshots (enumerated fresh each time),
	 * only their push signals require re-subscription after registration.
	 */
	subscribeAll(onChanged: () => void): () => void {
		const disposers: Array<() => void> = [];
		for (const provider of this.currentProviders()) {
			try {
				disposers.push(provider.subscribe?.(onChanged) ?? (() => {}));
			} catch {
				// a broken subscriber must not break the manager
			}
		}
		return () => {
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch {
					// ignore
				}
			}
		};
	}

	private currentProviders(): BackgroundWorkProvider[] {
		// Built-ins are session-bound because each pi-web session has its own
		// EventBus. Never take another session's adapters from the process-global
		// third-party registry.
		const builtins = [this.bgTasks, this.subagents, ...(this.webSubagents ? [this.webSubagents] : [])].filter((provider) =>
			provider.getAvailable(),
		);
		const builtinNames = new Set<string>(builtins.map((provider) => provider.name));
		const thirdParty = listBackgroundWorkProviders().filter(
			(provider) =>
				!(provider instanceof PiBackgroundTasksAdapter) &&
				!(provider instanceof PiSubagentsAdapter) &&
				!builtinNames.has(provider.name),
		);
		return [...builtins, ...thirdParty];
	}

	async snapshot(sessionId: string): Promise<AggregatedSnapshot> {
		const providers = this.currentProviders();
		if (providers.length === 0) {
			this.lastActiveIds = [];
			return { snapshots: [], totalActive: 0, activeIds: [], anyUnknown: false, hasProviders: false };
		}
		const snapshots = await snapshotAllProviders(providers, sessionId);
		let totalActive = 0;
		let anyUnknown = false;
		const activeIds: string[] = [];
		for (const snap of snapshots) {
			totalActive += snap.activeCount;
			activeIds.push(...snap.activeIds);
			if (snap.state === "unknown") anyUnknown = true;
		}
		this.lastActiveIds = activeIds;
		return { snapshots, totalActive, activeIds, anyUnknown, hasProviders: true };
	}

	/** Notify adapters that a session boundary occurred (/new, resume, fork). */
	markSessionBoundary(activeTaskIds?: Iterable<string>): void {
		this.bgTasks.markSessionBoundary(activeTaskIds ?? this.lastActiveIds);
	}

	dispose(): void {
		this.bgTasks.dispose();
		this.subagents.dispose();
	}
}
