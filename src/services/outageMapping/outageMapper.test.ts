import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapOutagesByUnit } from "./outageMapper";
import { PocpOutage } from "../../models/pocpOutage";
import { GeneratorDefinition } from "../../clients/generators";

describe("outageMapper", () => {
    it("empty list - empty result", () => {
        const result = mapOutagesByUnit([], []);
        expect(result).toEqual({});
    });

    it("block matches single unit easily", () => {
        const outages = [
            {
                outageBlock: "HLY_1"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                units: [
                    {
                        unitCode: "HLY1",
                        node: "HLY2201 HLY1"
                    }
                ]
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);
        expect(result).toEqual({
            "HLY2201 HLY1": [
                {
                    outageBlock: "HLY_1"
                }
            ]
        });
    })

    it("block matches multiple units on same generator easily", () => {
        const outages = [
            {
                outageBlock: "HLY_1"
            },
            {
                outageBlock: "HLY_1"
            },
            {
                outageBlock: "HLY_6"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                units: [
                    {
                        unitCode: "HLY1",
                        node: "HLY2201 HLY1"
                    },
                    {
                        unitCode: "HLY5",
                        node: "HLY2201 HLY5"
                    },
                    {
                        unitCode: "HLY6",
                        node: "HLY2201 HLY6"
                    }
                ]
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);
        expect(result).toEqual({
            "HLY2201 HLY1": [
                {
                    outageBlock: "HLY_1"
                },
                {
                    outageBlock: "HLY_1"
                }
            ],
            "HLY2201 HLY6": [
                {
                    outageBlock: "HLY_6"
                }
            ]
        });
    });

    it("no clear match - only one node on generator - allocates to that node", () => {
        const outages = [
            {
                outageBlock: "ATI_2"
            },
            {
                outageBlock: "ATI_3"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                site: "ATI",
                units: [
                    {
                        unitCode: "ATI0",
                        node: "ATI2201 ATI0"
                    }
                ]
            }] as GeneratorDefinition[];


        const result = mapOutagesByUnit(outages, generatorDefinitions);

        expect(result).toEqual({
            "ATI2201 ATI0": [
                {
                    outageBlock: "ATI_2"
                },
                {
                    outageBlock: "ATI_3"
                }
            ]
        });
    })

    it("loose match on unitCode when available", () => {
        const outages = [
            {
                outageBlock: "TCC_Stn"
            },
            {
                outageBlock: "SFD_21"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                site: "SFD",
                units: [
                    {
                        unitCode: "SFD21",
                        node: "SFD2201 SFD21"
                    },
                    {
                        unitCode: "TCC1",
                        node: "SFD2201 SPL0"
                    }
                ],
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);

        expect(result).toEqual({
            "SFD2201 SFD21": [
                {
                    outageBlock: "SFD_21"
                }
            ],
            "SFD2201 SPL0": [
                {
                    outageBlock: "TCC_Stn"
                }
            ]
        });
    })

    it("loose match on alias", () => {
        const outages = [
            {
                outageBlock: "KTS"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                site: "KSF",
                units: [
                    {
                        unitCode: "KSF0",
                        node: "KOE1101 KSF0"
                    }
                ],
                alias: "KTS"
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);

        expect(result).toEqual({
            "KOE1101 KSF0": [
                {
                    outageBlock: "KTS"
                }
            ]
        });
    });

    it("matches based on lowercase", () => {
        const outages = [
            {
                outageBlock: "toh"
            },
            {
                outageBlock: "abc1"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                site: "TOH",
                units: [
                    {
                        unitCode: "TOH1",
                        node: "TOH2201 TOH1"
                    }
                ]
            },
            {
                site: "ABC",
                units: [
                    {
                        unitCode: "ABC1",
                        node: "ABC2201 ABC1"
                    }
                ]
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);

        expect(result).toEqual({
            "ABC2201 ABC1": [
                {
                    outageBlock: "abc1"
                }
            ],
            "TOH2201 TOH1": [
                {
                    outageBlock: "toh"
                }
            ]
        });
    })

    it("matches based on node when unit code doesn't match", () => {
        const outages = [
            {
                outageBlock: "ARG_Stn"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                units: [
                    {
                        unitCode: "BRR0",
                        node: "ARG1101 BRR0"
                    }
                ]
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);
        expect(result).toEqual({
            "ARG1101 BRR0": [
                {
                    outageBlock: "ARG_Stn"
                }
            ]
        });
    })

    it("matches based on node bus", () => {
        const outages = [
            {
                outageBlock: "KAW2201"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                units: [
                    {
                        unitCode: "TAM0",
                        node: "KAW2201 TAM0"
                    }
                ]
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);
        expect(result).toEqual({
            "KAW2201 TAM0": [
                {
                    outageBlock: "KAW2201"
                }
            ]
        });
    })

    it("doesn't match a block that's only the start of a node's substation", () => {
        const outages = [
            {
                outageBlock: "ST"
            }
        ] as PocpOutage[];

        const generatorDefinitions = [
            {
                site: "COB",
                units: [
                    {
                        unitCode: "COB0",
                        node: "STK0661 COB0"
                    }
                ]
            }
        ] as GeneratorDefinition[];

        const result = mapOutagesByUnit(outages, generatorDefinitions);
        expect(result).toEqual({});
    })

    describe("units that are in and out of service", () => {
        beforeEach(() => {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        // Pātea moved from HWA1101 to OHG1101, so each unit code is listed at both nodes
        const movedUnitGenerators = [
            {
                site: "PTA",
                units: [
                    {
                        unitCode: "PTA1",
                        node: "HWA1101 PTA1",
                        commissioned: "1899-12-31T12:30:00.000Z",
                        decomissioned: "2026-06-25T01:59:59.999Z"
                    },
                    {
                        unitCode: "PTA2",
                        node: "HWA1101 PTA2",
                        commissioned: "1899-12-31T12:30:00.000Z",
                        decomissioned: "2026-06-25T01:59:59.999Z"
                    },
                    {
                        unitCode: "PTA1",
                        node: "OHG1101 PTA1",
                        commissioned: "2026-06-25T02:00:00.000Z"
                    },
                    {
                        unitCode: "PTA2",
                        node: "OHG1101 PTA2",
                        commissioned: "2026-06-25T02:00:00.000Z"
                    }
                ]
            }
        ] as GeneratorDefinition[];

        it("maps a unit that moved node to its new node", () => {
            const outages = [
                {
                    outageBlock: "PTA_1"
                },
                {
                    outageBlock: "PTA_2"
                },
                {
                    outageBlock: "PTA_STN"
                }
            ] as PocpOutage[];

            const result = mapOutagesByUnit(outages, movedUnitGenerators);
            expect(result).toEqual({
                "OHG1101 PTA1": [
                    {
                        outageBlock: "PTA_1"
                    },
                    {
                        outageBlock: "PTA_STN"
                    }
                ],
                "OHG1101 PTA2": [
                    {
                        outageBlock: "PTA_2"
                    }
                ]
            });
        })

        it("maps a unit to its old node until it moves", () => {
            vi.setSystemTime(new Date("2026-06-25T01:59:59.000Z"));

            const outages = [
                {
                    outageBlock: "PTA_1"
                }
            ] as PocpOutage[];

            const result = mapOutagesByUnit(outages, movedUnitGenerators);
            expect(result).toEqual({
                "HWA1101 PTA1": [
                    {
                        outageBlock: "PTA_1"
                    }
                ]
            });
        })

        it("maps a unit to its new node from when it's commissioned", () => {
            vi.setSystemTime(new Date("2026-06-25T02:00:00.000Z"));

            const outages = [
                {
                    outageBlock: "PTA_1"
                }
            ] as PocpOutage[];

            const result = mapOutagesByUnit(outages, movedUnitGenerators);
            expect(result).toEqual({
                "OHG1101 PTA1": [
                    {
                        outageBlock: "PTA_1"
                    }
                ]
            });
        })

        it("maps a site/alias match to the generator's in-service unit", () => {
            const outages = [
                {
                    outageBlock: "KTS"
                }
            ] as PocpOutage[];

            const generatorDefinitions = [
                {
                    site: "KSF",
                    units: [
                        {
                            unitCode: "KSF0",
                            node: "ABC1101 KSF0",
                            decomissioned: "2025-01-01T00:00:00.000Z"
                        },
                        {
                            unitCode: "KSF0",
                            node: "KOE1101 KSF0"
                        }
                    ],
                    alias: "KTS"
                }
            ] as GeneratorDefinition[];

            const result = mapOutagesByUnit(outages, generatorDefinitions);
            expect(result).toEqual({
                "KOE1101 KSF0": [
                    {
                        outageBlock: "KTS"
                    }
                ]
            });
        })

        it("keeps an outage on a retired unit rather than moving it to a looser in-service match", () => {
            const outages = [
                {
                    outageBlock: "TCC_Stn"
                }
            ] as PocpOutage[];

            const generatorDefinitions = [
                {
                    site: "SFD",
                    units: [
                        {
                            unitCode: "SFD21",
                            node: "SFD2201 SFD21"
                        },
                        {
                            unitCode: "TCC1",
                            node: "SFD2201 SPL0",
                            decomissioned: "2025-09-05T07:30:00.000Z"
                        }
                    ],
                    alias: "TCC"
                }
            ] as GeneratorDefinition[];

            const result = mapOutagesByUnit(outages, generatorDefinitions);
            expect(result).toEqual({
                "SFD2201 SPL0": [
                    {
                        outageBlock: "TCC_Stn"
                    }
                ]
            });
        })
    });
});