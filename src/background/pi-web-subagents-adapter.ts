/**
 * pi-web official subagent adapter — tracks subagents started by pi-web's own
 * built-in `Agent` tool (module "pi-web-subagents" in the pi-web bundle).
 *
 * pi-web has no public registry for its subagent manager, but every lifecycle
 * fact is persisted in the parent session journal, which is authoritative:
 *
 *   start:    { type: "message", message: { role: "toolResult", toolName: "Agent",
 *               details: { kind: "pi-web-subagent", sessionId, status, ... } } }
 *   progress: same shape with toolName "get_subagent_result"
 *   terminal: { type: "custom_message", customType: "pi-web:subagent-notification",
 *               details: { kind: "pi-web-subagent", sessionId, status, ... } }
 *
 * Statuses observed: starting | running | queued (active); completed | aborted |
 * interrupted | failed (terminal). Latest record per sessionId wins.
 *
 * No subscribe() signal on purpose: the terminal notification is delivered with
 * triggerTurn: true, so the parent session wakes by itself and the controller
 * re-queries at settle time. The wait-timeout re-arm is the backstop.
 */

import type { BackgroundWorkProvider, BackgroundWorkSnapshot } from "./types.ts";
import { unknownSnapshot } from "./types.ts";

const SUBAGENT_KIND = "pi-web-subagent";
const SUBAGENT_NOTIFICATION = "pi-web:subagent-notification";
const ACTIVE_STATUSES = new Set(["starting", "running", "queued"]);

export type JournalEntriesProvider = () => unknown[];

export class PiWebSubagentsAdapter implements BackgroundWorkProvider {
	readonly name = "pi-web-subagents";

	constructor(private readonly getEntries: JournalEntriesProvider) {}

	/** The journal is authoritative: no records simply means zero active subagents. */
	getAvailable(): boolean {
		return true;
	}

	async getActiveWork(_sessionId: string): Promise<BackgroundWorkSnapshot> {
		let entries: unknown[];
		try {
			entries = this.getEntries();
		} catch {
			return unknownSnapshot(this.name); // fail closed: stale ctx must block goals
		}
		const statusById = new Map<string, string>();
		for (const entry of entries) {
			const details = detailsOf(entry);
			if (!details || details.kind !== SUBAGENT_KIND) continue;
			const sessionId = details.sessionId;
			const status = details.status;
			if (typeof sessionId !== "string" || typeof status !== "string") continue;
			statusById.set(sessionId, status);
		}
		const activeIds = [...statusById].filter(([, status]) => ACTIVE_STATUSES.has(status)).map(([id]) => id);
		return {
			provider: this.name,
			activeCount: activeIds.length,
			activeIds,
			state: "known",
			checkedAt: Date.now(),
		};
	}
}

function detailsOf(entry: unknown): Record<string, unknown> | null {
	if (!entry || typeof entry !== "object") return null;
	const record = entry as { type?: string; customType?: string; message?: { role?: string; details?: unknown }; details?: unknown };
	if (record.type === "custom_message" && record.customType === SUBAGENT_NOTIFICATION) {
		return isRecord(record.details) ? record.details : null;
	}
	if (record.type === "message" && record.message?.role === "toolResult") {
		return isRecord(record.message.details) ? record.message.details : null;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
