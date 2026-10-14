import { env } from "cloudflare:workers";
import worker from "../worker";

// sends a request through the worker's fetch handler. work handed to waitUntil is collected, so tests can wait
// for it with finishBackgroundWork()
export async function requestWorker(path: string) {
	const backgroundWork: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			backgroundWork.push(promise);
		},
		passThroughOnException: () => { },
		props: {},
	} as unknown as ExecutionContext;

	const response = await worker.fetch(new Request(new URL(path, "https://api.test")), env, ctx);

	return {
		response,
		finishBackgroundWork: () => Promise.all(backgroundWork),
	};
}
