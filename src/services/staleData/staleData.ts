const ONE_HOUR_IN_MS = 60 * 60 * 1000;

export type DataSource = {
    id: string;
    name: string; // e.g. "offer files", as in "No new offer files for 2 days"
    checkpointKey: string; // the KV key the source's sync stores its progress in, with CheckpointMetadata
    maxAgeMs: number; // how long it can go without new data before it's stale
}

export type DataSourceStatus = DataSource & {
    updatedAt?: number; // when the sync last got new data. missing if it hasn't since it started recording it
}

/**
 * Works out which sources have gone stale or started getting new data again since they were last checked. alerted
 * is the ids of the sources already alerted as stale. A source that doesn't know when it last got new data keeps
 * whatever state it had.
 */
export function findStaleDataChanges(statuses: DataSourceStatus[], alerted: string[], now: number) {
    const known = statuses.filter(status => status.updatedAt !== undefined);
    const isStale = (status: DataSourceStatus) => now - status.updatedAt! > status.maxAgeMs;

    const newlyStale = known.filter(status => isStale(status) && !alerted.includes(status.id));
    const recovered = known.filter(status => !isStale(status) && alerted.includes(status.id));

    return {
        newlyStale,
        recovered,
        alerted: [
            ...alerted.filter(id => !recovered.some(status => status.id === id)),
            ...newlyStale.map(status => status.id),
        ],
    };
}

export function formatStaleDataMessage(newlyStale: DataSourceStatus[], recovered: DataSourceStatus[], now: number): string {
    return [
        ...newlyStale.map(status => `⏰ No new *${status.name}* for ${formatAge(now - status.updatedAt!)}`),
        ...recovered.map(status => `✅ Getting new *${status.name}* again`),
    ].join("\n");
}

// e.g. 1 hour, 47 hours, 3 days
function formatAge(ms: number): string {
    const hours = Math.floor(ms / ONE_HOUR_IN_MS);
    if (hours < 48) {
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `${Math.floor(hours / 24)} days`;
}
