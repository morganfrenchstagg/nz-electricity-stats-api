import { env } from "cloudflare:workers";
import { sendSlackMessage } from "../clients/slack";
import { CheckpointMetadata } from "../models/checkpointMetadata";
import { DataSource, findStaleDataChanges, formatStaleDataMessage } from "../services/staleData/staleData";

const ONE_HOUR_IN_MS = 60 * 60 * 1000;

// EMI publishes a daily dispatch file and an offers file every day, so 2 days without one means either it's stopped
// publishing them or the sync is failing
const DATA_SOURCES: DataSource[] = [
    { id: "rtd", name: "real time dispatch data", checkpointKey: "latestDispatchTime", maxAgeMs: ONE_HOUR_IN_MS },
    { id: "dailyDispatch", name: "daily dispatch files", checkpointKey: "latestDailySyncDate", maxAgeMs: 48 * ONE_HOUR_IN_MS },
    { id: "offers", name: "offer files", checkpointKey: "latestSyncedOffers", maxAgeMs: 48 * ONE_HOUR_IN_MS },
];

// the ids of the sources currently alerted as stale
const STALE_DATA_ALERTS_KEY = "staleDataAlerts";

// posts to Slack when a sync goes too long without getting new data, and again once it's getting new data again
export async function checkForStaleData() {
    const now = Date.now();

    const [statuses, previousAlerts] = await Promise.all([
        Promise.all(DATA_SOURCES.map(async source => {
            const { metadata } = await env.dispatch_kv.getWithMetadata<CheckpointMetadata>(source.checkpointKey);
            return { ...source, updatedAt: metadata?.updatedAt };
        })),
        env.dispatch_kv.get(STALE_DATA_ALERTS_KEY),
    ]);
    const alerted = previousAlerts ? JSON.parse(previousAlerts) as string[] : [];

    const { newlyStale, recovered, alerted: nowAlerted } = findStaleDataChanges(statuses, alerted, now);
    if (newlyStale.length === 0 && recovered.length === 0) {
        return;
    }

    await env.dispatch_kv.put(STALE_DATA_ALERTS_KEY, JSON.stringify(nowAlerted));

    console.log(`Stale data: ${newlyStale.map(status => status.id).join(", ") || "none"}, recovered: ${recovered.map(status => status.id).join(", ") || "none"}`);
    await sendSlackMessage(formatStaleDataMessage(newlyStale, recovered, now));
}
