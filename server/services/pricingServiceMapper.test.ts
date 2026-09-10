import { describe, it, expect } from "vitest";
import { mapPricingServiceResponse } from "./pricingServiceMapper";
import { PricingServiceResponse } from "./pricingServiceClient";

const FLOOR_WINS: PricingServiceResponse = {
  status: "success",
  price: { minimum: 3500, recommended: 3500, maximum: 4200, currency: "INR" },
  driver: "cost_floor",
  cost_breakdown: {
    material_cost: 480,
    crafting_hours: 24,
    hourly_wage_applied: 90,
    wage_source: "Rajasthan",
    labour: 2160,
    overhead: 264,
    production_cost: 2904,
    fair_margin_percent: 20,
    cost_floor: 3484.8,
  },
  model: {
    ran: true,
    reason: null,
    method: "embedding_retrieval",
    predicted_market_price: 2450,
    with_gi_prior: 2695,
    mean_similarity: 0.8025,
    weight_applied: 0.27,
    neighbours: [
      { id: "p1", title: "Blue pottery flower vase", price: 2450, similarity: 0.88, source: "sample", observed_date: "2026-08-28" },
    ],
    comparable_range: { min: 1250, max: 3200 },
  },
  assumptions: ['Crafting time "3 days" was counted as 24 hours, at 8 hours per working day.'],
  notes: ["Comparable items sell for less than this piece costs to make at a fair wage. Priced at your floor."],
  reliability: { score: 80, label: "High", components: { model_confidence: 30, crafting_time: 30, model_inputs: 20 } },
  channels: {
    direct: { platform: "Direct", fee_percent: 0, listing_price: 3500, take_home: 3500 },
  },
  catalogue: { version: "sample-fixture", date_range: { from: "2026-07-14", to: "2026-08-30" }, rows: 16 },
};

const NO_MODEL: PricingServiceResponse = {
  ...FLOOR_WINS,
  model: {
    ran: false,
    reason: "No photo or description was given, so no comparable listings were searched.",
    method: null,
    predicted_market_price: null,
    mean_similarity: null,
    weight_applied: 0,
    neighbours: [],
    comparable_range: null,
  },
  notes: ["No photo or description was given, so no comparable listings were searched."],
  reliability: { score: 40, label: "Low", components: {} },
};

describe("mapPricingServiceResponse", () => {
  it("carries the price band through unchanged", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.minimumPrice).toBe(3500);
    expect(result.recommendedPrice).toBe(3500);
    expect(result.maximumPrice).toBe(4200);
    expect(result.suggestedMin).toBe(3500);
    expect(result.suggestedMax).toBe(4200);
  });

  it("maps reliability score and label", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.recommendationReliability).toBe(80);
    expect(result.reliabilityLabel).toBe("High");
  });

  it("maps the cost breakdown fields", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.pricingBreakdown.materialCost).toBe(480);
    expect(result.pricingBreakdown.estimatedLabourCost).toBe(2160);
    expect(result.pricingBreakdown.overhead).toBe(264);
    expect(result.pricingBreakdown.productionCost).toBe(2904);
    expect(result.pricingBreakdown.fairPriceFloor).toBe(3484.8);
    expect(result.pricingBreakdown.categoryName).toBe("Pottery");
  });

  it("never fabricates a labourFactor, since the new engine does not use one", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.assumptions.labourFactor).toBe(0);
  });

  it("marks the market as available when the model ran and produced a price", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.marketReference.available).toBe(true);
    expect(result.marketReference.median).toBe(2450);
    expect(result.marketReference.min).toBe(1250);
    expect(result.marketReference.max).toBe(3200);
    expect(result.marketReference.sampleCount).toBe(1);
  });

  it("marks the market unavailable when the model did not run", () => {
    const result = mapPricingServiceResponse(NO_MODEL, { categoryName: "Pottery" });
    expect(result.marketReference.available).toBe(false);
    expect(result.marketReference.median).toBeNull();
    expect(result.pricingBreakdown.marketMedian).toBeNull();
  });

  it("includes the response notes and assumptions in the explanation text", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.reason).toContain("Priced at your floor");
    expect(result.reasoning).toContain("24 hours");
  });

  it("passes through complexity and subcategory when given", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, {
      categoryName: "Pottery",
      complexity: "detailed",
      subcategory: "vase",
    });
    expect(result.pricingBreakdown.complexity).toBe("detailed");
    expect(result.pricingBreakdown.subcategory).toBe("vase");
  });

  it("defaults complexity to standard and subcategory to null when omitted", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.pricingBreakdown.complexity).toBe("standard");
    expect(result.pricingBreakdown.subcategory).toBeNull();
  });

  it("computes overchargeCeiling as 30% above the maximum", () => {
    const result = mapPricingServiceResponse(FLOOR_WINS, { categoryName: "Pottery" });
    expect(result.overchargeCeiling).toBe(Math.round(4200 * 1.3));
  });

  it("flags the material cost assessment as capped when the response notes say so", () => {
    const capped: PricingServiceResponse = {
      ...FLOOR_WINS,
      notes: ["Material cost of 1000000 is far above the usual range for pottery, so we capped it at 2700."],
    };
    const result = mapPricingServiceResponse(capped, { categoryName: "Pottery" });
    expect(result.materialCostAssessment.wasCapped).toBe(true);
    expect(result.materialCostAssessment.status).toBe("above_typical_range");
  });
});
