import { describe, expect, it } from "vitest";
import { csvToJson } from "./csvToJson";

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