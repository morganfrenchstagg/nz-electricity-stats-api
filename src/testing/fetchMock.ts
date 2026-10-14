import { vi } from "vitest";

export type FetchRoutes = Record<string, (request: Request) => Response | Promise<Response>>;

// replaces global fetch for the current test, sending each request to the first route whose url prefix it
// matches. a request no route matches fails, so tests never reach the real network. returns every request made
export function mockFetch(routes: FetchRoutes): Request[] {
	const requests: Request[] = [];

	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request);

		const prefix = Object.keys(routes).find(prefix => request.url.startsWith(prefix));
		if (!prefix) {
			throw new Error(`Unexpected fetch to ${request.url}`);
		}
		return routes[prefix](request.clone());
	});

	return requests;
}

// a response whose body arrives in small chunks, like a large file download would
export function streamedResponse(text: string, chunkSize = 50): Response {
	const bytes = new TextEncoder().encode(text);
	let position = 0;

	return new Response(new ReadableStream({
		pull(controller) {
			if (position >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(position, position + chunkSize));
			position += chunkSize;
		},
	}));
}
