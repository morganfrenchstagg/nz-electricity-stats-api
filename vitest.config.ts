import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// the Workers runtime module isn't available in node, so tests get in-memory KV and R2 bindings instead
			"cloudflare:workers": fileURLToPath(new URL("./src/testing/cloudflareWorkers.ts", import.meta.url)),
		},
	},
	test: {
		setupFiles: ["./src/testing/setup.ts"],
		unstubGlobals: true,
		// the sync jobs log every step, so only show logs for failing tests
		silent: "passed-only",
	},
});
