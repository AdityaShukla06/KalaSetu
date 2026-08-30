import { describe, it, expect } from "vitest";
import { calculateSmartPrice, CATEGORY_DATASET, COMPLEXITY_FACTORS } from "./pricingEngine";

describe("calculateSmartPrice", () => {
  it("throws when no usable material cost is supplied", () => {
    expect(() => calculateSmartPrice({ category: "pottery" })).toThrow();
    expect(() => calculateSmartPrice({ category: "pottery", rawMaterials: [] })).toThrow();
  });

  it("derives the base price from the category material share", () => {
    const result = calculateSmartPrice({
      category: "pottery",
      materialCost: 250,
      complexity: "standard",
    });

    expect(result.breakdown.materialShare).toBe(CATEGORY_DATASET.pottery.materialShare);
    expect(result.breakdown.complexityFactor).toBe(COMPLEXITY_FACTORS.standard);
    expect(result.recommendedPrice).toBe(1000);
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

    expect(result.breakdown.materialCost).toBe(250);
  });

  it("orders the suggested range around the recommended price", () => {
    const result = calculateSmartPrice({ category: "textiles", materialCost: 1000 });

    expect(result.suggestedMin).toBeLessThanOrEqual(result.recommendedPrice);
    expect(result.recommendedPrice).toBeLessThanOrEqual(result.suggestedMax);
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

  it("falls back to the 'other' category for an unknown category", () => {
    const result = calculateSmartPrice({ category: "not-a-real-category", materialCost: 200 });

    expect(result.breakdown.categoryName).toBe(CATEGORY_DATASET.other.name);
  });

  it("infers complexity from the description when none is given", () => {
    const result = calculateSmartPrice({
      category: "jewelry",
      materialCost: 300,
      descriptionEn: "An intricate hand embroidered piece with fine carving",
    });

    expect(result.breakdown.complexity).toBe("complex");
  });

  it("infers a subcategory and attaches its market benchmark", () => {
    const result = calculateSmartPrice({
      category: "pottery",
      materialCost: 400,
      descriptionEn: "A tall ceramic vase for flowers",
    });

    expect(result.breakdown.subcategory).toBe("vase");
    expect(result.marketReference.available).toBe(true);
    expect(result.marketReference.median).toBe(2500);
  });

  it("reports no market reference when the subcategory is unknown", () => {
    const result = calculateSmartPrice({
      category: "other",
      materialCost: 400,
      descriptionEn: "A thing",
    });

    expect(result.marketReference.available).toBe(false);
    expect(result.marketReference.median).toBeNull();
  });

  it("keeps the confidence score within bounds and scores richer input higher", () => {
    const sparse = calculateSmartPrice({ category: "other", materialCost: 400 });
    const rich = calculateSmartPrice({
      category: "pottery",
      materialCost: 400,
      descriptionEn: "A tall ceramic vase for flowers",
      imageUrl: "https://example.com/vase.jpg",
    });

    for (const result of [sparse, rich]) {
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore).toBeLessThanOrEqual(100);
    }

    expect(rich.confidenceScore).toBeGreaterThan(sparse.confidenceScore);
  });

  it("keeps reason and reasoning in sync for the frontend", () => {
    const result = calculateSmartPrice({ category: "pottery", materialCost: 250 });

    expect(result.reason).toBe(result.reasoning);
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
