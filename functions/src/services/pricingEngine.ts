/**
 * SIH26090 - Smart Pricing Engine
 * Implements the 24-step formula, stored datasets, confidence scoring,
 * and market alignment benchmark from the SIH26090 specification.
 */

export interface RawMaterialItem {
  name: string;
  cost: number;
  quantity?: number | string;
  unit?: string;
}

export interface CategoryConfig {
  name: string;
  materialShare: number;
  rangeDown: number;
  rangeUp: number;
  categoryReliabilityScore: number;
}

export const CATEGORY_DATASET: Record<string, CategoryConfig> = {
  textiles: {
    name: "Textiles",
    materialShare: 0.20,
    rangeDown: 0.10,
    rangeUp: 0.20,
    categoryReliabilityScore: 20,
  },
  pottery: {
    name: "Pottery",
    materialShare: 0.25,
    rangeDown: 0.15,
    rangeUp: 0.20,
    categoryReliabilityScore: 15,
  },
  jewelry: {
    name: "Jewelry",
    materialShare: 0.16,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 20,
  },
  woodwork: {
    name: "Woodwork",
    materialShare: 0.16,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 20,
  },
  "bamboo-cane": {
    name: "Bamboo & Cane",
    materialShare: 0.20,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 15,
  },
  bamboo: {
    name: "Bamboo & Cane",
    materialShare: 0.20,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 15,
  },
  other: {
    name: "Other Handcrafts",
    materialShare: 0.20,
    rangeDown: 0.15,
    rangeUp: 0.20,
    categoryReliabilityScore: 10,
  },
};

export type ComplexityLevel = "simple" | "standard" | "detailed" | "complex" | "exceptional";

export const COMPLEXITY_FACTORS: Record<ComplexityLevel, number> = {
  simple: 0.90,
  standard: 1.00,
  detailed: 1.10,
  complex: 1.20,
  exceptional: 1.30,
};

export interface MarketBenchmark {
  marketMin: number;
  marketMedian: number;
  marketMax: number;
  sampleCount: number;
  sourceCount: number;
}

export const MARKET_REFERENCE: Record<string, Record<string, MarketBenchmark>> = {
  textiles: {
    saree: { marketMin: 2015, marketMedian: 5499, marketMax: 16500, sampleCount: 26, sourceCount: 4 },
    shawl: { marketMin: 750, marketMedian: 1499, marketMax: 3360, sampleCount: 7, sourceCount: 2 },
  },
  pottery: {
    vase: { marketMin: 250, marketMedian: 2500, marketMax: 5500, sampleCount: 7, sourceCount: 2 },
    plate: { marketMin: 150, marketMedian: 600, marketMax: 1800, sampleCount: 6, sourceCount: 2 },
    pot: { marketMin: 120, marketMedian: 450, marketMax: 1200, sampleCount: 8, sourceCount: 2 },
  },
  jewelry: {
    necklace: { marketMin: 180, marketMedian: 750, marketMax: 1500, sampleCount: 8, sourceCount: 2 },
    earrings: { marketMin: 199, marketMedian: 355, marketMax: 999, sampleCount: 8, sourceCount: 2 },
    bangle: { marketMin: 150, marketMedian: 500, marketMax: 1200, sampleCount: 5, sourceCount: 2 },
  },
  woodwork: {
    sculpture: { marketMin: 400, marketMedian: 2400, marketMax: 15000, sampleCount: 9, sourceCount: 2 },
    decorative: { marketMin: 100, marketMedian: 1000, marketMax: 4700, sampleCount: 9, sourceCount: 2 },
    toy: { marketMin: 120, marketMedian: 450, marketMax: 1500, sampleCount: 6, sourceCount: 2 },
  },
  "bamboo-cane": {
    basket: { marketMin: 185, marketMedian: 899, marketMax: 3500, sampleCount: 15, sourceCount: 3 },
    lamp: { marketMin: 177, marketMedian: 500, marketMax: 3200, sampleCount: 10, sourceCount: 2 },
    decorative: { marketMin: 90, marketMedian: 537, marketMax: 7400, sampleCount: 10, sourceCount: 2 },
  },
};

export interface PricingEngineInput {
  category: string;
  materialCost?: number;
  rawMaterials?: RawMaterialItem[];
  descriptionEn?: string;
  descriptionHi?: string;
  imageUrl?: string;
  complexity?: ComplexityLevel;
  subcategory?: string;
}

export interface PricingEngineOutput {
  success: boolean;
  suggestedMin: number;
  suggestedMax: number;
  recommendedPrice: number;
  minimumPrice: number;
  maximumPrice: number;
  reason: string;
  reasoning: string; // for backward compatibility with frontend
  confidenceScore: number;
  confidenceLabel: "Very High" | "High" | "Medium" | "Low" | "Very Low";
  marketReference: {
    available: boolean;
    min: number | null;
    median: number | null;
    max: number | null;
    sampleCount: number;
    sourceCount: number;
  };
  breakdown: {
    materialCost: number;
    rawMaterials?: RawMaterialItem[];
    basePrice: number;
    complexity: ComplexityLevel;
    complexityFactor: number;
    materialShare: number;
    categoryName: string;
    subcategory: string | null;
  };
}

function roundToSensibleInr(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (val < 100) return Math.round(val);
  if (val < 500) return Math.round(val / 5) * 5;
  if (val < 2000) return Math.round(val / 10) * 10;
  return Math.round(val / 50) * 50;
}

function inferSubcategory(categoryKey: string, text: string): string | null {
  const lower = text.toLowerCase();
  const catRef = MARKET_REFERENCE[categoryKey];
  if (!catRef) return null;

  for (const subKey of Object.keys(catRef)) {
    if (lower.includes(subKey)) return subKey;
  }

  // Keyword associations
  if (categoryKey === "textiles") {
    if (lower.includes("sari") || lower.includes("saree") || lower.includes("drape") || lower.includes("silk") || lower.includes("pallu")) return "saree";
    if (lower.includes("shawl") || lower.includes("stole") || lower.includes("scarf") || lower.includes("dupatta") || lower.includes("wrap")) return "shawl";
  } else if (categoryKey === "pottery") {
    if (lower.includes("vase") || lower.includes("vessel") || lower.includes("flower")) return "vase";
    if (lower.includes("plate") || lower.includes("dish") || lower.includes("thali") || lower.includes("bowl")) return "plate";
    if (lower.includes("pot") || lower.includes("matka") || lower.includes("handi") || lower.includes("planter")) return "pot";
  } else if (categoryKey === "jewelry") {
    if (lower.includes("necklace") || lower.includes("chain") || lower.includes("pendant") || lower.includes("choker") || lower.includes("haar")) return "necklace";
    if (lower.includes("earring") || lower.includes("jhumka") || lower.includes("stud")) return "earrings";
    if (lower.includes("bangle") || lower.includes("bracelet") || lower.includes("kada")) return "bangle";
  } else if (categoryKey === "woodwork") {
    if (lower.includes("statue") || lower.includes("sculpture") || lower.includes("idol") || lower.includes("carving") || lower.includes("murti")) return "sculpture";
    if (lower.includes("toy") || lower.includes("game") || lower.includes("puppet")) return "toy";
    if (lower.includes("decor") || lower.includes("tray") || lower.includes("box") || lower.includes("frame")) return "decorative";
  } else if (categoryKey === "bamboo-cane" || categoryKey === "bamboo") {
    if (lower.includes("basket") || lower.includes("tokri") || lower.includes("bin")) return "basket";
    if (lower.includes("lamp") || lower.includes("light") || lower.includes("lantern") || lower.includes("shade")) return "lamp";
    if (lower.includes("decor") || lower.includes("mat") || lower.includes("tray") || lower.includes("box")) return "decorative";
  }

  return null;
}

function inferComplexity(text: string): ComplexityLevel {
  const lower = text.toLowerCase();
  if (
    lower.includes("antique") ||
    lower.includes("masterpiece") ||
    lower.includes("gold leaf") ||
    lower.includes("heritage") ||
    lower.includes("national award") ||
    lower.includes("months to make") ||
    lower.includes("fine intricate filigree")
  ) {
    return "exceptional";
  }
  if (
    lower.includes("intricate") ||
    lower.includes("elaborate") ||
    lower.includes("fine carving") ||
    lower.includes("hand embroidered") ||
    lower.includes("complex") ||
    lower.includes("multi-layer")
  ) {
    return "complex";
  }
  if (
    lower.includes("detailed") ||
    lower.includes("pattern") ||
    lower.includes("embossed") ||
    lower.includes("hand-painted") ||
    lower.includes("polished finish")
  ) {
    return "detailed";
  }
  if (
    lower.includes("simple") ||
    lower.includes("plain") ||
    lower.includes("minimal") ||
    lower.includes("basic") ||
    lower.includes("raw finish")
  ) {
    return "simple";
  }
  return "standard";
}

/**
 * Calculates suggested prices and returns benchmark metadata
 */
export function calculateSmartPrice(input: PricingEngineInput): PricingEngineOutput {
  // 1. Determine effective material cost
  let effectiveMaterialCost = 0;
  if (Array.isArray(input.rawMaterials) && input.rawMaterials.length > 0) {
    effectiveMaterialCost = input.rawMaterials.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
  } else if (typeof input.materialCost === "number" && input.materialCost > 0) {
    effectiveMaterialCost = input.materialCost;
  }

  if (effectiveMaterialCost <= 0) {
    throw new Error("Material cost must be greater than 0");
  }

  // 2. Read Category Dataset
  const normalizedCategory = (input.category || "other").toLowerCase();
  const categoryConfig = CATEGORY_DATASET[normalizedCategory] || CATEGORY_DATASET["other"];
  const { materialShare, rangeDown, rangeUp, categoryReliabilityScore, name: categoryName } = categoryConfig;

  // 3. Determine Complexity
  const fullText = `${input.category || ""} ${input.descriptionEn || ""} ${input.descriptionHi || ""}`.trim();
  const complexity = input.complexity || inferComplexity(fullText);
  const complexityFactor = COMPLEXITY_FACTORS[complexity] || 1.0;

  // 4. Base Price & Recommended Price
  const basePrice = effectiveMaterialCost / materialShare;
  const rawRecommendedPrice = basePrice * complexityFactor;
  const rawMinimumPrice = rawRecommendedPrice * (1 - rangeDown);
  const rawMaximumPrice = rawRecommendedPrice * (1 + rangeUp);

  // 5. Sensible rounding
  const minimumPrice = roundToSensibleInr(rawMinimumPrice);
  const recommendedPrice = roundToSensibleInr(rawRecommendedPrice);
  const maximumPrice = roundToSensibleInr(rawMaximumPrice);

  // 6. Subcategory & Market Reference
  const selectedSubcategory = input.subcategory || inferSubcategory(normalizedCategory, fullText);
  const catMarket = MARKET_REFERENCE[normalizedCategory];
  const marketData: MarketBenchmark | undefined = selectedSubcategory && catMarket ? catMarket[selectedSubcategory] : undefined;

  const marketAvailable = Boolean(marketData);
  const marketMin = marketData ? marketData.marketMin : null;
  const marketMedian = marketData ? marketData.marketMedian : null;
  const marketMax = marketData ? marketData.marketMax : null;
  const sampleCount = marketData ? marketData.sampleCount : 0;
  const sourceCount = marketData ? marketData.sourceCount : 0;

  // 7. Market Deviation & Alignment Score
  let marketDeviation: number | null = null;
  let marketAlignmentScore = 0;

  if (marketAvailable && marketMedian && marketMedian > 0) {
    marketDeviation = Math.abs(recommendedPrice - marketMedian) / marketMedian;
    if (sampleCount < 5) {
      marketAlignmentScore = 10;
    } else if (marketMin !== null && marketMax !== null && recommendedPrice >= marketMin && recommendedPrice <= marketMax) {
      marketAlignmentScore = 30;
    } else if (marketDeviation <= 0.25) {
      marketAlignmentScore = 20;
    } else if (marketDeviation <= 0.50) {
      marketAlignmentScore = 10;
    } else {
      marketAlignmentScore = 5;
    }
  } else {
    marketAlignmentScore = 0;
  }

  // 8. Market Data Quality Score
  let marketDataQualityScore = 0;
  if (!marketAvailable) {
    marketDataQualityScore = 0;
  } else if (sampleCount >= 20 && sourceCount >= 3) {
    marketDataQualityScore = 30;
  } else if (sampleCount >= 10 && sourceCount >= 2) {
    marketDataQualityScore = 25;
  } else if (sampleCount >= 5 && sourceCount >= 2) {
    marketDataQualityScore = 20;
  } else if (sampleCount >= 5) {
    marketDataQualityScore = 15;
  } else {
    marketDataQualityScore = 10;
  }

  const marketComponent = Math.min(marketAlignmentScore, marketDataQualityScore);

  // 9. Input Completeness Score (max 20)
  let inputScore = 0;
  if (effectiveMaterialCost > 0) inputScore += 10;
  if (CATEGORY_DATASET[normalizedCategory]) inputScore += 5;
  if (input.descriptionEn && input.descriptionEn.trim().length > 0) inputScore += 3;
  if (input.imageUrl && input.imageUrl.startsWith("http")) inputScore += 2;

  // 10. Product Information Score (max 15)
  let productInformationScore = 0;
  const hasDesc = Boolean(input.descriptionEn && input.descriptionEn.trim());
  const hasImg = Boolean(input.imageUrl && input.imageUrl.startsWith("http"));
  if (hasDesc && hasImg) {
    productInformationScore = 15;
  } else if (hasDesc || hasImg) {
    productInformationScore = 8;
  }

  // 11. Calculation Validity Score (15 points)
  let calculationValidityScore = 15;
  if (
    materialShare <= 0 ||
    complexityFactor <= 0 ||
    !Number.isFinite(recommendedPrice) ||
    recommendedPrice <= 0 ||
    minimumPrice <= 0 ||
    maximumPrice <= 0
  ) {
    calculationValidityScore = 0;
  }

  // 12. Final Confidence Score (0 - 100)
  let rawConfidenceScore =
    inputScore +
    categoryReliabilityScore +
    marketComponent +
    productInformationScore +
    calculationValidityScore;

  const confidenceScore = Math.max(0, Math.min(100, Math.round(rawConfidenceScore)));

  // 13. Confidence Label
  let confidenceLabel: PricingEngineOutput["confidenceLabel"] = "Medium";
  if (confidenceScore >= 90) confidenceLabel = "Very High";
  else if (confidenceScore >= 75) confidenceLabel = "High";
  else if (confidenceScore >= 60) confidenceLabel = "Medium";
  else if (confidenceScore >= 40) confidenceLabel = "Low";
  else confidenceLabel = "Very Low";

  // 14. Market Explanation
  let marketExplanation = "";
  if (!marketAvailable) {
    marketExplanation = "Fair artisan value based on material costs and standard handcrafted labor markup.";
  } else if (marketMin !== null && marketMax !== null && recommendedPrice >= marketMin && recommendedPrice <= marketMax) {
    marketExplanation = `Aligns well with market benchmarks for ${selectedSubcategory ? selectedSubcategory : categoryName} (₹${marketMin} - ₹${marketMax}).`;
  } else if (marketDeviation !== null && marketDeviation <= 0.25) {
    marketExplanation = `Within 25% of market median (₹${marketMedian}) for similar artisanal items.`;
  } else if (marketDeviation !== null && marketDeviation <= 0.50) {
    marketExplanation = `Differs moderately from market median (₹${marketMedian}) due to customized craft complexity.`;
  } else {
    marketExplanation = `Reflects premium handcrafted value based on material input and craftsmanship.`;
  }

  // 15. Generate clear artisan reasoning
  let materialNote = `₹${effectiveMaterialCost} material cost`;
  if (Array.isArray(input.rawMaterials) && input.rawMaterials.length > 1) {
    materialNote = `₹${effectiveMaterialCost} itemized materials (${input.rawMaterials.map((m) => m.name || "item").slice(0, 3).join(", ")})`;
  }

  const complexityNote =
    complexity === "simple"
      ? "simple artisan craft"
      : complexity === "complex" || complexity === "exceptional"
      ? "intricate artisanal craftsmanship"
      : "standard handcrafted technique";

  const reason = `Based on ${materialNote}, ${categoryName} labor margin (${Math.round(
    (1 - materialShare) * 100
  )}%), and ${complexityNote}. ${marketExplanation}`;

  return {
    success: true,
    suggestedMin: minimumPrice,
    suggestedMax: maximumPrice,
    recommendedPrice,
    minimumPrice,
    maximumPrice,
    reason,
    reasoning: reason,
    confidenceScore,
    confidenceLabel,
    marketReference: {
      available: marketAvailable,
      min: marketMin,
      median: marketMedian,
      max: marketMax,
      sampleCount,
      sourceCount,
    },
    breakdown: {
      materialCost: effectiveMaterialCost,
      rawMaterials: input.rawMaterials,
      basePrice: roundToSensibleInr(basePrice),
      complexity,
      complexityFactor,
      materialShare,
      categoryName,
      subcategory: selectedSubcategory,
    },
  };
}
