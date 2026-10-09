import { describe, expect, it } from "vitest";
import { csvToJson, CsvRecordParser } from "./csvToJson";

describe("csvToJson", () => {
    it("should parse csv", async () => {
        const csv = "Price,Quantity\n1,2\n2,1\n2,2\n";

        const output = await csvToJson(csv);

        expect(output).toEqual([
            { Price: "1", Quantity: "2" },
            { Price: "2", Quantity: "1" },
            { Price: "2", Quantity: "2" }
        ])
    });

    it("should parse csv, empty elements", async () => {
        const csv = "Price,Quantity\n1,2\n,1\n2,\n";

        const output = await csvToJson(csv);

        expect(output).toEqual([
            { Price: "1", Quantity: "2" },
            { Price: "", Quantity: "1" },
            { Price: "2", Quantity: "" }
        ])
    })

    it("should parse csv, empty element doesn't shift the following columns", async () => {
        const csv = "IntervalDateTime,RunDateTime,CaseTypeCode,PointOfConnectionCode,UnitCode\n2026-09-01T00:00:00.000+12:00,,RTD,ARA2201,ARA0\n";

        const output = await csvToJson(csv);

        expect(output).toEqual([
            { IntervalDateTime: "2026-09-01T00:00:00.000+12:00", RunDateTime: "", CaseTypeCode: "RTD", PointOfConnectionCode: "ARA2201", UnitCode: "ARA0" }
        ])
    });

    it("should parse csv, quoted elements", async () => {
        const csv = 'Name,Value\n"Branch River, Arnold",1\n"say ""hi""",2\n';

        const output = await csvToJson(csv);

        expect(output).toEqual([
            { Name: "Branch River, Arnold", Value: "1" },
            { Name: 'say "hi"', Value: "2" }
        ])
    });

    it("should parse csv, windows line endings", async () => {
        const csv = "Price,Quantity\r\n1,2\r\n,1\r\n";

        const output = await csvToJson(csv);

        expect(output).toEqual([
            { Price: "1", Quantity: "2" },
            { Price: "", Quantity: "1" }
        ])
    });

    it("should parse csv, no trailing newline and blank lines", async () => {
        const csv = "Price,Quantity\n1,2\n\n2,1";

        const output = await csvToJson(csv);

        expect(output).toEqual([
            { Price: "1", Quantity: "2" },
            { Price: "2", Quantity: "1" }
        ])
    });

    it("should give the same output when the csv is written in chunks, wherever the chunks are split", async () => {
        const csv = 'Name,Value,Note\r\n"Branch River, Arnold",1,\r\n"say ""hi""",,"multi\nline"\n,3,x\nlast,4,"end"';
        const expected = await csvToJson(csv);

        for (let chunkSize = 1; chunkSize <= csv.length; chunkSize++) {
            const output = [] as Record<string, string>[];
            const parser = new CsvRecordParser((record) => output.push(record));
            for (let i = 0; i < csv.length; i += chunkSize) {
                parser.write(csv.slice(i, i + chunkSize));
            }
            parser.end();

            expect(output, `chunk size ${chunkSize}`).toEqual(expected);
        }

        expect(expected).toEqual([
            { Name: "Branch River, Arnold", Value: "1", Note: "" },
            { Name: 'say "hi"', Value: "", Note: "multi\nline" },
            { Name: "", Value: "3", Note: "x" },
            { Name: "last", Value: "4", Note: "end" },
        ]);
    });

    it("should parse massive csv", async () => {
        const ROWS = 1000_000;
        const headers = ["Id", "Name", "Price", "Quantity", "Category", "InStock"];

        const rows = Array.from({ length: ROWS }, (_, i) => [
            i + 1,
            `Product_${i + 1}`,
            i % 10 === 0 ? "" : ((i * 1.99) % 1000).toFixed(2),
            i % 7 === 0 ? "" : (i % 500),
            `Category_${i % 20}`,
            i % 2 === 0 ? "true" : "false"
        ].join(","));

        const csv = [headers.join(","), ...rows].join("\n");

        const output = await csvToJson(csv);

        expect(output).toHaveLength(ROWS);

        /*
        // Spot-check first row
        expect(output[0]).toEqual({
            Id: "1",
            Name: "Product_1",
            Price: "1.99",
            Quantity: "1",
            Category: "Category_1",
            InStock: "false"
        });

        // Spot-check empty Price (every 10th row, 0-indexed so row index 10 = i=10)
        expect(output[10]).toMatchObject({ Id: "11", Price: "" });

        // Spot-check empty Quantity (every 7th row, i=7 → index 7)
        expect(output[7]).toMatchObject({ Id: "8", Quantity: "" });

        // Spot-check last row
        expect(output[ROWS - 1]).toMatchObject({ Id: String(ROWS) });
        */
    });
})