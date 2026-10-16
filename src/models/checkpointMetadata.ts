// stored with a sync's checkpoint in KV (e.g. latestDispatchTime), so the stale data check can tell how long it's
// been since the sync last got new data
export type CheckpointMetadata = {
    updatedAt: number; // ms since epoch
}
