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
  confidenceScore?: number;
  confidenceLabel?: "Very High" | "High" | "Medium" | "Low" | "Very Low";
  marketReference?: {
    available: boolean;
    min: number | null;
    median: number | null;
    max: number | null;
    sampleCount: number;
    sourceCount: number;
  };
  breakdown?: {
    materialCost: number;
    rawMaterials?: RawMaterialItem[];
    basePrice: number;
    complexity: string;
    complexityFactor: number;
    materialShare: number;
    categoryName: string;
    subcategory: string | null;
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
