import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InvalidDateError } from "./dates";

// requests a /v1 path from the API. the worker passes its own routes, so the tools get exactly what the API returns
// without a round trip over the network
export type FetchApi = (path: string) => Promise<Response>;

// a mistake in a tool's arguments, which the agent is told about so it can try again
export class ToolInputError extends Error { }

export class ApiClient {
	constructor(private fetchApi: FetchApi) { }

	// null when the API has no data for it
	async get<T>(path: string): Promise<T | null> {
		const response = await this.fetchApi(path);
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			const body = await response.json().catch(() => null) as { message?: string } | null;
			throw new Error(`${path} returned ${response.status}${body?.message ? `: ${body.message}` : ""}`);
		}
		return await response.json() as T;
	}
}

// runs a tool, returning its result as JSON, or its error for the agent to read rather than failing the whole call
export async function runTool(handler: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		const result = await handler();
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	} catch (e) {
		if (!(e instanceof ToolInputError || e instanceof InvalidDateError)) {
			console.error("MCP tool failed", e);
		}
		return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
	}
}

export function round(value: number, decimals = 3): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

// maps over items a few at a time, so a long date range doesn't hold every day's dispatch in memory at once
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await map(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}
