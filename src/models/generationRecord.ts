// a generating unit's highest generation in a single interval
export type GenerationRecord = {
    mw: number;
    time: string; // the interval, in NZ time (e.g. 2026-10-14T22:00:00)
}

// the records found in the daily dispatch files, by node (e.g. HLY2201 HLY5)
export type HistoricalGenerationRecords = {
    syncedTo: string; // the last daily dispatch file read (e.g. 20261014)
    records: Record<string, GenerationRecord>;
}
