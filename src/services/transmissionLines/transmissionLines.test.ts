import { describe, expect, it } from "vitest";
import { isStale, isValidTransmissionLines, TRANSMISSION_LINES_MAX_AGE_SECONDS } from "./transmissionLines";

describe("isValidTransmissionLines", () => {
    const feature = { type: "Feature", geometry: { type: "MultiLineString", coordinates: [] }, properties: {} };

    it("accepts a feature collection with features", () => {
        expect(isValidTransmissionLines({ type: "FeatureCollection", features: [feature] })).toBe(true);
    });

    it("rejects an arcgis error body", () => {
        expect(isValidTransmissionLines({ error: { code: 500, message: "Error" } })).toBe(false);
    });

    it("rejects an empty feature collection", () => {
        expect(isValidTransmissionLines({ type: "FeatureCollection", features: [] })).toBe(false);
    });

    it("rejects a truncated result", () => {
        expect(isValidTransmissionLines({ type: "FeatureCollection", features: [feature], exceededTransferLimit: true })).toBe(false);
        expect(isValidTransmissionLines({ type: "FeatureCollection", features: [feature], properties: { exceededTransferLimit: true } })).toBe(false);
    });

    it("rejects null", () => {
        expect(isValidTransmissionLines(null)).toBe(false);
    });
});

describe("isStale", () => {
    const now = 1_800_000_000_000;
    const maxAgeMs = TRANSMISSION_LINES_MAX_AGE_SECONDS * 1000;

    it("missing metadata is stale", () => {
        expect(isStale(null, now)).toBe(true);
    });

    it("fresh within a day", () => {
        expect(isStale({ fetchedAt: now - maxAgeMs + 1 }, now)).toBe(false);
    });

    it("stale after a day", () => {
        expect(isStale({ fetchedAt: now - maxAgeMs }, now)).toBe(true);
    });
});
