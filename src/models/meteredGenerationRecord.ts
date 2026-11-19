// a unit's metered generation, or a point of connection's metered load, over a trading period, stored by the period's
// start in the metered day files (see syncMeteredGeneration), as the daily dispatch files store each interval's dispatch
export type MeteredGenerationRecord = {
    p: string; // node, e.g. ATI2201 ATI0 for a unit or ABY0111 for a point of connection's load
    g: number; // average generation (MW), always 0 for a point of connection's load
    l: number; // average load (MW), e.g. a unit's station load while it's idle
}
