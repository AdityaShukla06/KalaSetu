import { describe, it, expect } from "vitest";
import { calculateSmartPrice, getMarketWeight, PRICING_CONFIG } from "./pricingEngine";

describe("getMarketWeight", () => {
  it("gives strong evidence weight for 26 samples", () => {
    expect(getMarketWeight(true, 26)).toBe(0.40);
  });

  it("gives moderate evidence weight for 15 samples", () => {
    expect(getMarketWeight(true, 15)).toBe(0.25);
  });

  it("gives weak evidence weight for 7 samples", () => {
    expect(getMarketWeight(true, 7)).toBe(0.10);
  });

  it("gives zero weight for 3 samples", () => {
    expect(getMarketWeight(true, 3)).toBe(0);
  });

  it("gives zero weight when no market data exists", () => {
    expect(getMarketWeight(false, 100)).toBe(0);
  });
});

describe("calculateSmartPrice", () => {
  it("throws on invalid material cost", () => {
    expect(() => calculateSmartPrice({ category: "pottery", materialCost: 0 })).toThrow();
    expect(() => calculateSmartPrice({ category: "pottery", materialCost: -50 })).toThrow();
    expect(() => calculateSmartPrice({ category: "pottery" })).toThrow();
  });

  it("throws on an unsupported category", () => {
    expect(() => calculateSmartPrice({ category: "not-a-real-category", materialCost: 200 })).toThrow(
      "Unsupported category"
    );
  });

  it("sums itemized raw materials in preference to a flat material cost", () => {
    const result = calculateSmartPrice({
      category: "pottery",
      materialCost: 9999,
      rawMaterials: [
        { name: "clay", cost: 150 },
        { name: "glaze", cost: 100 },
      ],
    });

    expect(result.pricingBreakdown.materialCost).toBe(250);
  });

  it("derives production cost from material cost, estimated labour and overhead", () => {
    const result = calculateSmartPrice({
      category: "pottery",
      materialCost: 1000,
      complexity: "complex",
      subcategory: "does-not-exist",
    });

    const labourFactor = PRICING_CONFIG.labourFactors.complex;
    const expectedLabour = 1000 * labourFactor;
    const expectedOverhead = (1000 + expectedLabour) * PRICING_CONFIG.overheadRate;
    const expectedProductionCost = 1000 + expectedLabour + expectedOverhead;
    const expectedFairFloor = expectedProductionCost * (1 + PRICING_CONFIG.fairMargin);

    expect(Math.abs(result.pricingBreakdown.estimatedLabourCost - expectedLabour)).toBeLessThanOrEqual(50);
    expect(Math.abs(result.pricingBreakdown.overhead - expectedOverhead)).toBeLessThanOrEqual(50);
    expect(Math.abs(result.pricingBreakdown.productionCost - expectedProductionCost)).toBeLessThanOrEqual(50);
    expect(Math.abs(result.pricingBreakdown.fairPriceFloor - expectedFairFloor)).toBeLessThanOrEqual(50);
  });

  it("uses the fair price floor as the recommended price when no market data exists", () => {
    const result = calculateSmartPrice({
      category: "other",
      materialCost: 400,
      descriptionEn: "A thing",
    });

    expect(result.marketReference.available).toBe(false);
    expect(result.recommendedPrice).toBe(result.minimumPrice);
    expect(result.pricingBreakdown.marketWeight).toBe(0);
  });

  it("treats an unknown subcategory the same as no market data", () => {
    const result = calculateSmartPrice({
      category: "pottery",
      materialCost: 400,
      subcategory: "does-not-exist",
    });

    expect(result.marketReference.available).toBe(false);
    expect(result.recommendedPrice).toBe(result.minimumPrice);
    expect(result.pricingBreakdown.marketWeight).toBe(0);
  });

  it("weighs strong market evidence into the recommended price without dropping below the fair floor", () => {
    const result = calculateSmartPrice({
      category: "textiles",
      materialCost: 2000,
      complexity: "detailed",
      subcategory: "saree",
    });

    expect(result.marketReference.sampleCount).toBe(26);
    expect(result.pricingBreakdown.marketWeight).toBe(0.40);
    expect(result.recommendedPrice).toBeGreaterThanOrEqual(result.minimumPrice);
  });

  it("never recommends a price below the fair price floor even when the market median is far lower", () => {
    const result = calculateSmartPrice({
      category: "jewelry",
      materialCost: 1000,
      complexity: "standard",
      subcategory: "bangle",
    });

    expect(result.marketReference.median).toBeLessThan(result.pricingBreakdown.fairPriceFloor);
    expect(result.recommendedPrice).toBeGreaterThanOrEqual(result.pricingBreakdown.fairPriceFloor);
  });

  it("falls back to standard complexity when an invalid value is supplied and lowers reliability", () => {
    const base = {
      category: "woodwork" as const,
      materialCost: 500,
      subcategory: "sculpture",
    };

    const withInvalidComplexity = calculateSmartPrice({
      ...base,
      complexity: "ultra-fancy" as any,
    });
    const withExplicitStandard = calculateSmartPrice({
      ...base,
      complexity: "standard",
    });

    expect(withInvalidComplexity.pricingBreakdown.complexity).toBe("standard");
    expect(withInvalidComplexity.recommendationReliability).toBeLessThan(
      withExplicitStandard.recommendationReliability
    );
  });

  it("orders the suggested range around the recommended price", () => {
    const result = calculateSmartPrice({ category: "textiles", materialCost: 1000 });

    expect(result.minimumPrice).toBeLessThanOrEqual(result.recommendedPrice);
    expect(result.recommendedPrice).toBeLessThanOrEqual(result.maximumPrice);
  });

  it("raises the price for more complex work", () => {
    const simple = calculateSmartPrice({ category: "woodwork", materialCost: 500, complexity: "simple" });
    const exceptional = calculateSmartPrice({
      category: "woodwork",
      materialCost: 500,
      complexity: "exceptional",
    });

    expect(exceptional.recommendedPrice).toBeGreaterThan(simple.recommendedPrice);
  });

  it("infers a subcategory and attaches its market benchmark", () => {
    const result = calculateSmartPrice({
      category: "pottery",
      materialCost: 400,
      descriptionEn: "A tall ceramic vase for flowers",
    });

    expect(result.pricingBreakdown.subcategory).toBe("vase");
    expect(result.marketReference.available).toBe(true);
    expect(result.marketReference.median).toBe(2500);
  });

  it("keeps the reliability score within bounds and scores richer input higher", () => {
    const sparse = calculateSmartPrice({ category: "other", materialCost: 400 });
    const rich = calculateSmartPrice({
      category: "pottery",
      materialCost: 400,
      descriptionEn: "A tall hand-thrown ceramic vase with a glossy glaze finish",
      imageUrl: "https://example.com/vase.jpg",
    });

    for (const result of [sparse, rich]) {
      expect(result.recommendationReliability).toBeGreaterThanOrEqual(0);
      expect(result.recommendationReliability).toBeLessThanOrEqual(100);
    }

    expect(rich.recommendationReliability).toBeGreaterThan(sparse.recommendationReliability);
  });

  it("keeps reason and reasoning in sync for the frontend", () => {
    const result = calculateSmartPrice({ category: "pottery", materialCost: 250 });

    expect(result.reason).toBe(result.reasoning);
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
