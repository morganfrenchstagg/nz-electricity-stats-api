export type HistoricalDispatchRecord = {
    p: string; // point of connection code
    l: string; // load megawatts
    g: string; // generation megawatts - for a unit, its MW at the start of the interval rather than what it was dispatched to
    c: string; // cost ($/MWh)
    m?: boolean; // units only: whether the file's initial and dispatched generation match
}