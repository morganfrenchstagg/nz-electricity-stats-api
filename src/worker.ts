import { Hono } from "hono";

const app = new Hono();

app.get("ping", async (c) => {
  // Do something and return an HTTP response
  // Optionally, do something with `c.req.param("slug")`
  return c.text("pong");
});


export default app;