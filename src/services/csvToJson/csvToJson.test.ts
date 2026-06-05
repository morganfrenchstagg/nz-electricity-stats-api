import { describe, expect, it } from "vitest";
import { csvToJson } from "./csvToJson";

describe("csvToJson", () => {
    it("should parse csv", () => {
        const csv = "Price,Quantity\n1,2\n2,1\n2,2\n";

        const output = csvToJson(csv);

        expect(output).toEqual([
            {Price: "1", Quantity: "2"},
            {Price: "2", Quantity: "1"},
            {Price: "2", Quantity: "2"}
        ])
    });

    it("should parse csv, empty elements", () => {
        const csv = "Price,Quantity\n1,2\n,1\n2,\n";

        const output = csvToJson(csv);

        expect(output).toEqual([
            {Price: "1", Quantity: "2"},
            {Price: "", Quantity: "1"},
            {Price: "2", Quantity: ""}
        ])
    })
})