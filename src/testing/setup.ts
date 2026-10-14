import { afterEach, beforeEach, vi } from "vitest";
import { resetEnv } from "./cloudflareWorkers";

beforeEach(() => {
	resetEnv();
});

afterEach(() => {
	vi.useRealTimers();
});
