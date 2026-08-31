/**
 * BackgroundWorkProvider abstraction + open process-local registry.
 *
 * The goal layer never knows about specific background plugins — it only asks
 * `backgroundWork.hasActiveWork(sessionId)` / `snapshotAll(sessionId)`.
 *
 * Open protocol for third-party background extensions
 * ---------------------------------------------------
 * The registry lives at `Symbol.for("pi-goal.background-work.v1")` on
 * globalThis and has the stable shape:
 *
 *   interface BackgroundWorkRegistryV1 {
 *     version: 1;
 *     providers: Map<string, BackgroundWorkProvider>;
 *   }
 *
 * Register from any extension (no pi-goal import required):
 *
 *   const key = Symbol.for("pi-goal.background-work.v1");
 *   const reg = (globalThis as any)[key] ?? ((globalThis as any)[key] = { version: 1, providers: new Map() });
 *   reg.providers.set("my-plugin", {
 *     name: "my-plugin",
 *     async getActiveWork(sessionId) { ... },
 *     subscribe(onChanged) { ...; return () => {...}; }, // optional wake signal
 *   });
 *
 * Fail-closed rule: when a provider cannot confirm its state (timeout,
 * malformed reply, plugin gone), report `state: "unknown"` — the goal layer
 * treats unknown the same as active work and keeps waiting.
 */

export interface BackgroundWorkSnapshot {
	provider: string;
	activeCount: number;
	activeIds: string[];
	/** "unknown" means the provider could not confirm state; fail closed. */
	state: "known" | "unknown";
	checkedAt: number;
}

export interface BackgroundWorkProvider {
	name: string;
	getActiveWork(sessionId: string): Promise<BackgroundWorkSnapshot>;
	/** Optional change signal (completion events). Signal only — snapshot is authoritative. */
	subscribe?(onChanged: () => void): () => void;
}

export const BACKGROUND_WORK_REGISTRY_KEY = "pi-goal.background-work.v1";

export interface BackgroundWorkRegistryV1 {
	version: 1;
	providers: Map<string, BackgroundWorkProvider>;
}

function isProvider(value: unknown): value is BackgroundWorkProvider {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof (value as BackgroundWorkProvider).name === "string" &&
		typeof (value as BackgroundWorkProvider).getActiveWork === "function"
	);
}

/** Get or create the process-local registry. Safe to call before pi-goal loads. */
export function ensureBackgroundWorkRegistry(): BackgroundWorkRegistryV1 {
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const key = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);
	const existing = globalObject[key];
	if (existing && typeof existing === "object" && (existing as BackgroundWorkRegistryV1).version === 1 && (existing as BackgroundWorkRegistryV1).providers instanceof Map) {
		return existing as BackgroundWorkRegistryV1;
	}
	const created: BackgroundWorkRegistryV1 = { version: 1, providers: new Map() };
	globalObject[key] = created;
	return created;
}

export function registerBackgroundWorkProvider(provider: BackgroundWorkProvider): () => void {
	if (!isProvider(provider)) throw new Error("BackgroundWorkProvider requires name and getActiveWork().");
	const registry = ensureBackgroundWorkRegistry();
	registry.providers.set(provider.name, provider);
	return () => {
		if (registry.providers.get(provider.name) === provider) registry.providers.delete(provider.name);
	};
}

export function listBackgroundWorkProviders(): BackgroundWorkProvider[] {
	return [...ensureBackgroundWorkRegistry().providers.values()].filter(isProvider);
}

/** Aggregate snapshot across every registered provider for one session. */
export async function snapshotAllProviders(providers: BackgroundWorkProvider[], sessionId: string): Promise<BackgroundWorkSnapshot[]> {
	return Promise.all(
		providers.map(async (provider) => {
			try {
				const snapshot = await withTimeout(provider.getActiveWork(sessionId), 5000);
				if (!snapshot || typeof snapshot !== "object") return unknownSnapshot(provider.name);
				return {
					provider: provider.name ?? snapshot.provider,
					activeCount: Number.isFinite(snapshot.activeCount) ? Math.max(0, Math.floor(snapshot.activeCount)) : 0,
					activeIds: Array.isArray(snapshot.activeIds) ? snapshot.activeIds.filter((id) => typeof id === "string") : [],
					state: snapshot.state === "unknown" ? "unknown" : "known",
					checkedAt: Date.now(),
				} satisfies BackgroundWorkSnapshot;
			} catch {
				return unknownSnapshot(provider.name);
			}
		}),
	);
}

export function unknownSnapshot(provider: string): BackgroundWorkSnapshot {
	return { provider, activeCount: 0, activeIds: [], state: "unknown", checkedAt: Date.now() };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("background-work query timed out")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
