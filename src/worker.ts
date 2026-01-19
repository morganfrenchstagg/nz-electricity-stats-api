import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.get("/", async (c) => {
  return c.redirect("https://electricitymap.frenchsta.gg/");
});

app.get("ping", async (c) => {
  return c.text("pong");
});

app.use(cors());

function scheduled(controller: ScheduledController) {
  console.log("Scheduled task executed");
}

export default {
  fetch: app.fetch,
  scheduled: scheduled,
}