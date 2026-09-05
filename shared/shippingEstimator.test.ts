import { describe, it, expect } from "vitest";
import { isValidIndianPincode, classifyShippingZone, estimateShippingCost, estimateShippingByZone } from "./shippingEstimator";
import { SHIPPING_ZONES, ZONE_RATES } from "./shippingRateCard";

describe("isValidIndianPincode", () => {
  it("accepts a well-formed 6-digit pincode", () => {
    expect(isValidIndianPincode("560001")).toBe(true);
  });

  it("rejects a pincode starting with 0", () => {
    expect(isValidIndianPincode("012345")).toBe(false);
  });

  it("rejects the wrong number of digits", () => {
    expect(isValidIndianPincode("12345")).toBe(false);
    expect(isValidIndianPincode("1234567")).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(isValidIndianPincode("abcdef")).toBe(false);
  });
});

describe("classifyShippingZone", () => {
  it("classifies an identical pincode as local", () => {
    expect(classifyShippingZone("560001", "560001")).toBe("local");
  });

  it("classifies the same 3-digit prefix as local", () => {
    expect(classifyShippingZone("560001", "560034")).toBe("local");
  });

  it("classifies the same postal circle (matching first 2 digits) as withinState", () => {
    expect(classifyShippingZone("560001", "562123")).toBe("withinState");
  });

  it("classifies two different metro prefixes as metroToMetro", () => {
    expect(classifyShippingZone("400001", "110001")).toBe("metroToMetro");
  });

  it("classifies a Jammu & Kashmir destination as special", () => {
    expect(classifyShippingZone("560001", "190001")).toBe("special");
  });

  it("classifies a North-East destination as special", () => {
    expect(classifyShippingZone("560001", "781001")).toBe("special");
  });

  it("falls back to restOfIndia for an unmatched cross-state pair", () => {
    expect(classifyShippingZone("560001", "302001")).toBe("restOfIndia");
  });
});

describe("estimateShippingCost", () => {
  it("returns null for an invalid pincode", () => {
    expect(estimateShippingCost(1, "12345", "560001")).toBeNull();
  });

  it("returns null for a non-positive weight", () => {
    expect(estimateShippingCost(0, "560001", "560002")).toBeNull();
    expect(estimateShippingCost(-2, "560001", "560002")).toBeNull();
  });

  it("always returns a range, never a single value", () => {
    const result = estimateShippingCost(1, "560001", "110001");
    expect(result).not.toBeNull();
    expect(result!.minCost).toBeLessThan(result!.maxCost);
  });

  it("identifies the correct zone alongside the cost range", () => {
    const result = estimateShippingCost(1, "560001", "560002");
    expect(result?.zone).toBe("local");
  });

  it("charges more for a heavier package in the same zone", () => {
    const light = estimateShippingCost(0.4, "560001", "560002")!;
    const heavy = estimateShippingCost(5, "560001", "560002")!;
    expect(heavy.minCost).toBeGreaterThan(light.minCost);
  });

  it("charges more for a farther zone at the same weight", () => {
    const local = estimateShippingCost(1, "560001", "560002")!;
    const special = estimateShippingCost(1, "560001", "190001")!;
    expect(special.minCost).toBeGreaterThan(local.minCost);
  });
});

describe("estimateShippingByZone", () => {
  it("returns null for a non-positive weight", () => {
    expect(estimateShippingByZone(0)).toBeNull();
  });

  it("returns a cost range for every zone in the rate card", () => {
    const result = estimateShippingByZone(1);
    expect(result).not.toBeNull();
    for (const zone of SHIPPING_ZONES) {
      expect(result![zone].minCost).toBeLessThan(result![zone].maxCost);
      expect(result![zone].minCost).toBeGreaterThan(0);
    }
  });

  it("orders zones from cheapest to most expensive the same way the rate card does", () => {
    const result = estimateShippingByZone(1)!;
    expect(result.local.minCost).toBeLessThan(result.withinState.minCost);
    expect(result.withinState.minCost).toBeLessThan(result.metroToMetro.minCost);
    expect(result.metroToMetro.minCost).toBeLessThan(result.restOfIndia.minCost);
    expect(result.restOfIndia.minCost).toBeLessThan(result.special.minCost);
  });

  it("matches a manually computed value for a simple case", () => {
    const rate = ZONE_RATES.local;
    const expectedBase = rate.baseFor500g * 1.10 * 1.18;
    const result = estimateShippingByZone(0.5)!;
    expect(result.local.minCost).toBe(Math.round(expectedBase * 0.85));
    expect(result.local.maxCost).toBe(Math.round(expectedBase * 1.20));
  });
});
