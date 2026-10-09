export type AggregateResolution = "daily" | "weekly" | "monthly" | "annual";

export type NodeEnergy = {
    g: number; // generation (MWh)
    l: number; // load (MWh)
}

export type AggregateDataPoint = {
    from: string; // first date of the period (inclusive, NZ trading date)
    to: string; // last date of the period (inclusive, NZ trading date)
    nodes: Record<string, NodeEnergy>;
}

// a single stored file, e.g. all the daily data points for a month (see getAggregateKey)
export type DispatchAggregate = {
    data: AggregateDataPoint[];
}

// the api response, in the same shape as the other dispatch timeseries (e.g. /v1/dispatch/recent)
export type DispatchAggregateTimeseries = {
    series: string[]; // nodes
    data: (string | number)[][]; // [first date of the period, ...net MWh (generation - load) for each node in series]
}
