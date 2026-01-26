CREATE TABLE IF NOT EXISTS real_time_dispatch (
    PointOfConnectionCode TEXT NOT NULL,
	FiveMinuteIntervalDatetime DATETIME NOT NULL,
	SPDLoadMegawatt FLOAT NOT NULL,
	SPDGenerationMegawatt FLOAT NOT NULL,
	DollarsPerMegawattHour FLOAT NOT NULL,
	PRIMARY KEY (PointOfConnectionCode, FiveMinuteIntervalDatetime)
);