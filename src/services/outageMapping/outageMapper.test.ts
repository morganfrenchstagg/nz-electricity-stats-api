import { describe, expect, it } from "vitest";
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
});