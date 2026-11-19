// files written before November 2026 have the numbers as strings, so they're read with + to work with either
export type HistoricalDispatchRecord = {
    p: string; // point of connection code
    l: number | string; // load megawatts
    g: number | string; // generation megawatts - for a unit, its MW at the start of the interval rather than what it was dispatched to
    c: number | string; // cost ($/MWh)
    m?: boolean; // units only: whether the file's initial and dispatched generation match
}
