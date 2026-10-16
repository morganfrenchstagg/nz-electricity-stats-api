// a unit's metered generation over a trading period, stored by the period's start in the metered day files (see
// syncMeteredGeneration), as the daily dispatch files store each interval's dispatch
export type MeteredGenerationRecord = {
    p: string; // node
    g: number; // average generation (MW)
    l: number; // average load (MW), e.g. its station load while it's idle
}
