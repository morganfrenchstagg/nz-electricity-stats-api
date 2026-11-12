import { afterEach, beforeEach, vi } from "vitest";
import { edgeCacheStorage, resetEnv } from "./cloudflareWorkers";

beforeEach(() => {
	resetEnv();
	vi.stubGlobal("caches", edgeCacheStorage);
});

afterEach(() => {
	vi.useRealTimers();
});
