import { ComplexityLevel, MaterialCostAssessment, PricingEngineOutput } from "./pricingEngine";
import { PricingServiceResponse } from "./pricingServiceClient";

const LABOUR_FACTOR_NOT_APPLICABLE = 0;

function reliabilityLabel(label: string): "Very High" | "High" | "Medium" | "Low" | "Very Low" {
  if (label === "High" || label === "Medium" || label === "Low" || label === "Very Low") return label;
  return "Very Low";
}

function materialCostAssessmentFrom(response: PricingServiceResponse): MaterialCostAssessment {
  const entered = response.cost_breakdown.material_cost;
  const capped = response.notes.some((note) => note.toLowerCase().includes("capped"));
  return {
    status: capped ? "above_typical_range" : "within_range",
    typicalMin: null,
    typicalMax: null,
    enteredMaterialCost: entered,
    materialCostUsedForCalculation: entered,
    wasCapped: capped,
  };
}

function buildReason(response: PricingServiceResponse): string {
  const parts = [
    `Production cost is ₹${Math.round(response.cost_breakdown.production_cost)}, giving a fair price floor of ₹${Math.round(response.cost_breakdown.cost_floor)}.`,
  ];
  if (response.driver === "market" && response.model.predicted_market_price !== null) {
    parts.push(
      `Comparable listings support a higher price, so the recommendation is ₹${response.price.recommended}.`,
    );
  } else {
    parts.push(`The recommendation is priced at your fair cost floor of ₹${response.price.recommended}.`);
  }
  parts.push(...response.notes);
  return parts.join(" ");
}

function buildReasoning(response: PricingServiceResponse): string {
  return [...response.assumptions, ...response.notes].join(" ");
}

export function mapPricingServiceResponse(
  response: PricingServiceResponse,
  input: { complexity?: ComplexityLevel; subcategory?: string | null; categoryName: string },
): PricingEngineOutput {
  const marketAvailable = response.model.ran && response.model.predicted_market_price !== null;

  return {
    success: true,
    suggestedMin: response.price.minimum,
    suggestedMax: response.price.maximum,
    minimumPrice: response.price.minimum,
    recommendedPrice: response.price.recommended,
    maximumPrice: response.price.maximum,
    reason: buildReason(response),
    reasoning: buildReasoning(response),
    recommendationReliability: response.reliability.score,
    reliabilityLabel: reliabilityLabel(response.reliability.label),
    overchargeCeiling: Math.round(response.price.maximum * 1.3),
    materialCostAssessment: materialCostAssessmentFrom(response),
    pricingBreakdown: {
      materialCost: response.cost_breakdown.material_cost,
      materialCostUsedForCalculation: response.cost_breakdown.material_cost,
      estimatedLabourCost: response.cost_breakdown.labour,
      overhead: response.cost_breakdown.overhead,
      productionCost: response.cost_breakdown.production_cost,
      fairPriceFloor: response.cost_breakdown.cost_floor,
      marketMedian: marketAvailable ? response.model.predicted_market_price : null,
      marketWeight: response.model.weight_applied,
      costWeight: 1 - response.model.weight_applied,
      complexity: input.complexity ?? "standard",
      subcategory: input.subcategory ?? null,
      categoryName: input.categoryName,
    },
    marketReference: {
      available: marketAvailable,
      min: response.model.comparable_range?.min ?? null,
      median: marketAvailable ? response.model.predicted_market_price : null,
      max: response.model.comparable_range?.max ?? null,
      sampleCount: response.model.neighbours.length,
      sourceCount: new Set(response.model.neighbours.map((n) => n.source)).size,
    },
    assumptions: {
      labourFactor: LABOUR_FACTOR_NOT_APPLICABLE,
      overheadRate:
        response.cost_breakdown.material_cost + response.cost_breakdown.labour > 0
          ? response.cost_breakdown.overhead /
            (response.cost_breakdown.material_cost + response.cost_breakdown.labour)
          : 0.1,
      fairMargin: response.cost_breakdown.fair_margin_percent / 100,
    },
  };
}
