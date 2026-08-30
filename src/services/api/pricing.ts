import { apiFetch } from "./_helpers";

export interface RawMaterialItem {
  name: string;
  cost: number;
  quantity?: number | string;
  unit?: string;
}

export interface PricingSuggestionInput {
  category: string;
  materialCost?: number;
  rawMaterials?: RawMaterialItem[];
  descriptionEn?: string;
  descriptionHi?: string;
  imageUrl?: string;
  complexity?: "simple" | "standard" | "detailed" | "complex" | "exceptional";
  subcategory?: string;
}

export interface PricingSuggestionOutput {
  suggestedMin: number;
  suggestedMax: number;
  recommendedPrice?: number;
  minimumPrice?: number;
  maximumPrice?: number;
  reasoning: string;
  reason?: string;
  recommendationReliability?: number;
  reliabilityLabel?: "Very High" | "High" | "Medium" | "Low" | "Very Low";
  marketReference?: {
    available: boolean;
    min: number | null;
    median: number | null;
    max: number | null;
    sampleCount: number;
    sourceCount: number;
  };
  pricingBreakdown?: {
    materialCost: number;
    estimatedLabourCost: number;
    overhead: number;
    productionCost: number;
    fairPriceFloor: number;
    marketMedian: number | null;
    marketWeight: number;
    costWeight: number;
    complexity: string;
    subcategory: string | null;
    categoryName: string;
  };
  assumptions?: {
    labourFactor: number;
    overheadRate: number;
    fairMargin: number;
  };
}

// POST /pricing/suggest
// Supports both a single `materialCost` and an itemized `rawMaterials` array.
export function suggestPrice(input: PricingSuggestionInput): Promise<PricingSuggestionOutput> {
  return apiFetch("/pricing/suggest", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
