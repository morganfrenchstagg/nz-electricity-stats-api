import { env } from "cloudflare:workers";
import { Hono } from "hono";

const app = new Hono();

app.get("/", async (c) => {
	const offers = await env.DB.prepare("SELECT * FROM offers").all();
	return c.json(offers);
});

export default app;