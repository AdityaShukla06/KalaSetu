import { describe, it, expect } from "vitest";
import {
  calculateSmartPrice,
  getMarketWeight,
  assessMaterialCost,
  assessOvercharge,
  PRICING_CONFIG,
  MATERIAL_COST_REFERENCE_RANGES,
} from "./pricingEngine";

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

  it("scales proportionally with material cost", () => {
    const ten = calculateSmartPrice({ category: "textiles", materialCost: 10 });
    const tenThousand = calculateSmartPrice({ category: "textiles", materialCost: 10000 });

    expect(ten.suggestedMin).toBe(20);
    expect(tenThousand.suggestedMin).toBeGreaterThan(19000);
    expect(tenThousand.recommendedPrice / ten.recommendedPrice).toBeGreaterThan(900);
  });

  it("always reports a reliability label", () => {
    for (const input of [
      { category: "woodwork", materialCost: 250 },
      { category: "other", materialCost: 10 },
      { category: "pottery", materialCost: 400, descriptionEn: "A vase", imageUrl: "https://x/y.jpg" },
    ]) {
      const result = calculateSmartPrice(input);
      expect(result.reliabilityLabel).toBeTruthy();
      expect(typeof result.reliabilityLabel).toBe("string");
    }
  });

  it("keeps reason and reasoning in sync for the frontend", () => {
    const result = calculateSmartPrice({ category: "pottery", materialCost: 250 });

    expect(result.reason).toBe(result.reasoning);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("caps a wildly inflated material cost so it cannot keep dragging the price up", () => {
    const potteryMax = MATERIAL_COST_REFERENCE_RANGES.pottery.typicalMax;
    const capCeiling = potteryMax * PRICING_CONFIG.materialCostCapMultiplier;

    const inflated = calculateSmartPrice({ category: "pottery", materialCost: 1_000_000 });
    const atCapCeiling = calculateSmartPrice({ category: "pottery", materialCost: capCeiling });

    expect(inflated.materialCostAssessment.wasCapped).toBe(true);
    expect(inflated.materialCostAssessment.materialCostUsedForCalculation).toBe(capCeiling);
    expect(inflated.materialCostAssessment.status).toBe("above_typical_range");
    expect(inflated.recommendedPrice).toBe(atCapCeiling.recommendedPrice);
    expect(inflated.pricingBreakdown.materialCost).toBe(1_000_000);
  });

  it("does not cap a material cost that is high but still within the cap multiplier", () => {
    const potteryMax = MATERIAL_COST_REFERENCE_RANGES.pottery.typicalMax;
    const justUnderCap = potteryMax * PRICING_CONFIG.materialCostCapMultiplier - 1;

    const result = calculateSmartPrice({ category: "pottery", materialCost: justUnderCap });

    expect(result.materialCostAssessment.wasCapped).toBe(false);
    expect(result.materialCostAssessment.materialCostUsedForCalculation).toBe(justUnderCap);
  });

  it("surfaces a below-range material cost without capping it upward", () => {
    const potteryMin = MATERIAL_COST_REFERENCE_RANGES.pottery.typicalMin;
    const tinyCost = potteryMin / PRICING_CONFIG.materialCostWarningMultiplier - 1;

    const result = calculateSmartPrice({ category: "pottery", materialCost: tinyCost });

    expect(result.materialCostAssessment.status).toBe("below_typical_range");
    expect(result.materialCostAssessment.wasCapped).toBe(false);
    expect(result.materialCostAssessment.materialCostUsedForCalculation).toBe(tinyCost);
  });

  it("reports within_range for an ordinary material cost", () => {
    const result = calculateSmartPrice({ category: "pottery", materialCost: 300 });
    expect(result.materialCostAssessment.status).toBe("within_range");
    expect(result.materialCostAssessment.wasCapped).toBe(false);
  });

  it("falls back to no_reference for a category with no baseline, without throwing", () => {
    const assessment = assessMaterialCost("not-a-real-category", 500);
    expect(assessment.status).toBe("no_reference");
    expect(assessment.wasCapped).toBe(false);
    expect(assessment.materialCostUsedForCalculation).toBe(500);
  });

  it("mentions the capped material cost in the plain-language explanation", () => {
    const result = calculateSmartPrice({ category: "pottery", materialCost: 1_000_000 });
    expect(result.reason).toContain("capped material cost");
  });
});

describe("assessOvercharge", () => {
  it("does not flag a listed price within the suggested range", () => {
    const suggestion = calculateSmartPrice({ category: "pottery", materialCost: 300 });
    const assessment = assessOvercharge(suggestion, suggestion.recommendedPrice);

    expect(assessment.flagged).toBe(false);
    expect(assessment.reason).toBeNull();
  });

  it("flags a listed price well above the suggested range with a neutral, factual reason", () => {
    const suggestion = calculateSmartPrice({ category: "pottery", materialCost: 300 });
    const wayTooHigh = suggestion.overchargeCeiling + 5000;

    const assessment = assessOvercharge(suggestion, wayTooHigh);

    expect(assessment.flagged).toBe(true);
    expect(assessment.reason).toContain("Priced above typical range for this category");
    expect(assessment.reason).toContain(String(suggestion.minimumPrice));
    expect(assessment.reason).toContain(String(suggestion.maximumPrice));
    expect(assessment.reason?.toLowerCase()).not.toContain("overcharg");
    expect(assessment.reason?.toLowerCase()).not.toContain("seller");
  });

  it("does not flag right at the overcharge ceiling", () => {
    const suggestion = calculateSmartPrice({ category: "pottery", materialCost: 300 });
    const assessment = assessOvercharge(suggestion, suggestion.overchargeCeiling);

    expect(assessment.flagged).toBe(false);
  });

  it("allows listing above the suggested maximum as long as it stays under the overcharge ceiling", () => {
    const suggestion = calculateSmartPrice({ category: "pottery", materialCost: 300 });
    const aboveMaxButUnderCeiling = Math.round((suggestion.maximumPrice + suggestion.overchargeCeiling) / 2);

    const assessment = assessOvercharge(suggestion, aboveMaxButUnderCeiling);

    expect(assessment.flagged).toBe(false);
  });
});
