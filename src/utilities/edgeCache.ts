import { MiddlewareHandler } from "hono";

// when a response was put in the cache (ms since the epoch), so the time it's spent there can be taken off its max-age
const CACHED_AT_HEADER = "X-Edge-Cached-At";

// a Worker's responses only reach Cloudflare's cache if the Worker puts them there, so their Cache-Control on its own
// only saves the browser that made the request from asking again. this keeps each successful response with a max-age
// in the data center's cache for that long, so e.g. a past day's dispatch is only read from R2 and rebuilt once per
// data center rather than once per visitor. each data center has a cache of its own, and Cloudflare can drop entries
// before they expire, so a miss just runs the route as usual
export const edgeCache: MiddlewareHandler = async (c, next) => {
	const cache = typeof caches === "undefined" ? undefined : caches.default;
	if (c.req.method !== "GET" || !cache) {
		await next();
		return;
	}

	// by URL alone, as the query (e.g. ?nodes=) is the only part of the request the routes vary by
	const key = c.req.url;
	const cached = await cache.match(key);
	if (cached) {
		return withAge(cached);
	}

	await next();

	if (c.res.status === 200 && getMaxAge(c.res.headers.get("Cache-Control")) > 0) {
		const response = new Response(c.res.clone().body, c.res);
		response.headers.set(CACHED_AT_HEADER, String(Date.now()));
		c.executionCtx.waitUntil(cache.put(key, response));
	}
};

// a cached response keeps the max-age it was put there with, so it says how long it's been cached for, as a CDN's
// would, for browsers to only keep it for the rest of that rather than the whole max-age again
function withAge(cached: Response): Response {
	const response = new Response(cached.body, cached);
	const cachedAt = Number(response.headers.get(CACHED_AT_HEADER));
	response.headers.delete(CACHED_AT_HEADER);
	if (cachedAt > 0) {
		response.headers.set("Age", String(Math.max(0, Math.floor((Date.now() - cachedAt) / 1000))));
	}
	return response;
}

// 0 for responses that shouldn't be shared between visitors
export function getMaxAge(cacheControl: string | null): number {
	if (!cacheControl || /\b(no-store|no-cache|private)\b/.test(cacheControl)) {
		return 0;
	}
	const match = cacheControl.match(/\bmax-age=(\d+)/);
	return match ? +match[1] : 0;
}
