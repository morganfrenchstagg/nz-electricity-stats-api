export type OfferRecord = {
    TradingDate: string;
    TradingPeriod: string;
    ParticipantCode: string;
    PointOfConnection: string;
    Unit: string;
    ProductType: string;
    ProductClass: string;
    ReserveType: string;
    ProductDescription: string;
    UTCSubmissionDate: string;
    UTCSubmissionTime: string;
    SubmissionOrder: string;
    IsLatestYesNo: string;
    Tranche: string;
    MaximumRampUpMegawattsPerHour: string;
    MaximumRampDownMegawattsPerHour: string;
    PartiallyLoadedSpinningReservePercent: string;
    MaximumOutputMegawatts: string;
    ForecastOfGenerationPotentialMegawatts: string;
    Megawatts: string;
    DollarsPerMegawattHour: string;
}