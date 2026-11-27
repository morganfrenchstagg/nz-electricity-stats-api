import { Context } from "hono";

export const ONE_HOUR_IN_SECONDS = 60 * 60;
export const ONE_DAY_IN_SECONDS = ONE_HOUR_IN_SECONDS * 24;

export function getServiceUnavailableResponse(c: Context, message: string) {
  return c.json({ message }, 503, { "Cache-Control": "no-store" });
}
