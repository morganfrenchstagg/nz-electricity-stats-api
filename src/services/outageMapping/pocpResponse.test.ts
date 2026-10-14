import { describe, expect, it } from "vitest";
import { isValidPocpOutageResponse } from "./pocpResponse";

describe("isValidPocpOutageResponse", () => {
    it("accepts a response with outages", () => {
        expect(isValidPocpOutageResponse({ items: [{ outageBlock: "HLY_1" }], page: { pageNumber: 0, pageSize: 1000, total: 1 } })).toBe(true);
    });

    it("rejects an empty outage list", () => {
        expect(isValidPocpOutageResponse({ items: [], page: { pageNumber: 0, pageSize: 1000, total: 0 } })).toBe(false);
    });

    it("rejects an error body without items", () => {
        expect(isValidPocpOutageResponse({ status: 503, message: "Service Unavailable" })).toBe(false);
    });

    it("rejects items that aren't a list", () => {
        expect(isValidPocpOutageResponse({ items: { outageBlock: "HLY_1" } })).toBe(false);
        expect(isValidPocpOutageResponse({ items: null })).toBe(false);
    });

    it("rejects null", () => {
        expect(isValidPocpOutageResponse(null)).toBe(false);
    });
});
