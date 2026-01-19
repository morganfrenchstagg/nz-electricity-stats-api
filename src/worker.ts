import { Hono } from "hono";
import { cors } from "hono/cors";
import { syncOffers } from "./Offers/syncOffers";
import { syncDispatch } from "./Dispatch/syncDispatch";

const app = new Hono();

app.get("/", async (c) => {
  return c.redirect("https://electricitymap.frenchsta.gg/");
});

app.get("ping", async (c) => {
  return c.text("pong");
});

app.use(cors());

function scheduled(controller: ScheduledController) {
  switch (controller.cron) {
    case "*/2 * * * *":
      syncDispatch();
      break;
    case "8 * * * *":
      syncOffers();
      break;
  }
}

export default {
  fetch: app.fetch,
  scheduled: scheduled,
}