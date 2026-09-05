export interface RawMaterialItem {
  name: string;
  cost: number;
  quantity?: number | string;
  unit?: string;
}

export interface CategoryConfig {
  name: string;
}

export const CATEGORY_DATASET: Record<string, CategoryConfig> = {
  textiles: { name: "Textiles" },
  pottery: { name: "Pottery" },
  jewelry: { name: "Jewelry" },
  woodwork: { name: "Woodwork" },
  "bamboo-cane": { name: "Bamboo & Cane" },
  bamboo: { name: "Bamboo & Cane" },
  other: { name: "Other Handcrafts" },
};

export type ComplexityLevel = "simple" | "standard" | "detailed" | "complex" | "exceptional";

const COMPLEXITY_LEVELS: ComplexityLevel[] = ["simple", "standard", "detailed", "complex", "exceptional"];

function isValidComplexity(value: unknown): value is ComplexityLevel {
  return typeof value === "string" && (COMPLEXITY_LEVELS as string[]).includes(value);
}

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

export const PRICING_CONFIG: {
  labourFactors: Record<ComplexityLevel, number>;
  overheadRate: number;
  fairMargin: number;
  marketWeights: { high: number; medium: number; low: number; insufficient: number };
  maximumMarkup: number;
  materialCostWarningMultiplier: number;
  materialCostCapMultiplier: number;
  overchargeThreshold: number;
} = {
  labourFactors: {
    simple: 0.30,
    standard: 0.50,
    detailed: 0.80,
    complex: 1.20,
    exceptional: 1.60,
  },
  overheadRate: 0.10,
  fairMargin: 0.20,
  marketWeights: {
    high: 0.40,
    medium: 0.25,
    low: 0.10,
    insufficient: 0.00,
  },
  maximumMarkup: 0.20,
  materialCostWarningMultiplier: 2,
  materialCostCapMultiplier: 3,
  overchargeThreshold: 0.30,
};

export interface MaterialCostBaseline {
  typicalMin: number;
  typicalMax: number;
}

export const MATERIAL_COST_REFERENCE_NOTE =
  "Rule-based reference ranges for typical raw-material cost per category. Not verified market data, not a hard limit on listing price, and not the output of a trained model.";

export const MATERIAL_COST_REFERENCE_RANGES: Record<string, MaterialCostBaseline> = {
  textiles: { typicalMin: 80, typicalMax: 4000 },
  pottery: { typicalMin: 20, typicalMax: 900 },
  jewelry: { typicalMin: 50, typicalMax: 6000 },
  woodwork: { typicalMin: 60, typicalMax: 3500 },
  "bamboo-cane": { typicalMin: 20, typicalMax: 700 },
  bamboo: { typicalMin: 20, typicalMax: 700 },
  other: { typicalMin: 20, typicalMax: 5000 },
};

export type MaterialCostStatus = "within_range" | "above_typical_range" | "below_typical_range" | "no_reference";

export interface MaterialCostAssessment {
  status: MaterialCostStatus;
  typicalMin: number | null;
  typicalMax: number | null;
  enteredMaterialCost: number;
  materialCostUsedForCalculation: number;
  wasCapped: boolean;
}

export function assessMaterialCost(categoryKey: string, enteredMaterialCost: number): MaterialCostAssessment {
  const baseline = MATERIAL_COST_REFERENCE_RANGES[categoryKey];
  if (!baseline) {
    return {
      status: "no_reference",
      typicalMin: null,
      typicalMax: null,
      enteredMaterialCost,
      materialCostUsedForCalculation: enteredMaterialCost,
      wasCapped: false,
    };
  }

  const capCeiling = baseline.typicalMax * PRICING_CONFIG.materialCostCapMultiplier;
  const warnCeiling = baseline.typicalMax * PRICING_CONFIG.materialCostWarningMultiplier;
  const warnFloor = baseline.typicalMin / PRICING_CONFIG.materialCostWarningMultiplier;

  const materialCostUsedForCalculation = Math.min(enteredMaterialCost, capCeiling);
  const wasCapped = materialCostUsedForCalculation < enteredMaterialCost;

  let status: MaterialCostStatus = "within_range";
  if (enteredMaterialCost > warnCeiling) status = "above_typical_range";
  else if (enteredMaterialCost < warnFloor) status = "below_typical_range";

  return {
    status,
    typicalMin: baseline.typicalMin,
    typicalMax: baseline.typicalMax,
    enteredMaterialCost,
    materialCostUsedForCalculation,
    wasCapped,
  };
}

export interface OverchargeAssessment {
  flagged: boolean;
  reason: string | null;
  overchargeCeiling: number;
}

export function assessOvercharge(suggestion: PricingEngineOutput, listedPrice: number): OverchargeAssessment {
  const overchargeCeiling = suggestion.overchargeCeiling;
  if (!Number.isFinite(listedPrice) || listedPrice <= overchargeCeiling) {
    return { flagged: false, reason: null, overchargeCeiling };
  }

  const reason =
    `Priced above typical range for this category. Listed at ₹${roundToSensibleInr(listedPrice)}; ` +
    `suggested range ₹${suggestion.minimumPrice}–₹${suggestion.maximumPrice}.`;

  return { flagged: true, reason, overchargeCeiling };
}

export function getMarketWeight(marketAvailable: boolean, sampleCount: number): number {
  if (!marketAvailable) return PRICING_CONFIG.marketWeights.insufficient;
  if (sampleCount >= 20) return PRICING_CONFIG.marketWeights.high;
  if (sampleCount >= 10) return PRICING_CONFIG.marketWeights.medium;
  if (sampleCount >= 5) return PRICING_CONFIG.marketWeights.low;
  return PRICING_CONFIG.marketWeights.insufficient;
}

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
  minimumPrice: number;
  recommendedPrice: number;
  maximumPrice: number;
  reason: string;
  reasoning: string;
  recommendationReliability: number;
  reliabilityLabel: "Very High" | "High" | "Medium" | "Low" | "Very Low";
  overchargeCeiling: number;
  materialCostAssessment: MaterialCostAssessment;
  pricingBreakdown: {
    materialCost: number;
    materialCostUsedForCalculation: number;
    estimatedLabourCost: number;
    overhead: number;
    productionCost: number;
    fairPriceFloor: number;
    marketMedian: number | null;
    marketWeight: number;
    costWeight: number;
    complexity: ComplexityLevel;
    subcategory: string | null;
    categoryName: string;
  };
  marketReference: {
    available: boolean;
    min: number | null;
    median: number | null;
    max: number | null;
    sampleCount: number;
    sourceCount: number;
  };
  assumptions: {
    labourFactor: number;
    overheadRate: number;
    fairMargin: number;
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

function buildMaterialCostNote(assessment: MaterialCostAssessment, categoryName: string): string {
  if (assessment.status === "above_typical_range") {
    const cappedNote = assessment.wasCapped
      ? ` To keep the suggestion fair, this calculation used a capped material cost of ₹${roundToSensibleInr(assessment.materialCostUsedForCalculation)} instead.`
      : "";
    return `The material cost you entered is well above the typical range for ${categoryName} (₹${assessment.typicalMin}–₹${assessment.typicalMax}).${cappedNote}`;
  }
  if (assessment.status === "below_typical_range") {
    return `The material cost you entered is well below the typical range for ${categoryName} (₹${assessment.typicalMin}–₹${assessment.typicalMax}). Double check it's correct.`;
  }
  return "";
}

function buildExplanation(params: {
  productionCost: number;
  fairPriceFloor: number;
  marketAvailable: boolean;
  marketMedian: number | null;
  sampleCount: number;
  recommendedPrice: number;
  materialCostAssessment: MaterialCostAssessment;
  categoryName: string;
}): string {
  const productionCostText = `Your estimated production cost is ₹${roundToSensibleInr(params.productionCost)}. This includes material cost, estimated labour, and overhead.`;
  const fairFloorText = `A fair artisan margin gives a minimum fair price of ₹${roundToSensibleInr(params.fairPriceFloor)}.`;
  const materialCostNote = buildMaterialCostNote(params.materialCostAssessment, params.categoryName);

  if (!params.marketAvailable || params.marketMedian === null) {
    return `${productionCostText} ${fairFloorText} No reliable market benchmark was available for this product segment. The recommendation is therefore based primarily on estimated production cost and the fair artisan margin.${materialCostNote ? ` ${materialCostNote}` : ""}`;
  }

  const marketText = `Comparable products have a market median of ₹${roundToSensibleInr(params.marketMedian)} based on ${params.sampleCount} samples.`;
  const recommendationText = `The recommended price of ₹${params.recommendedPrice} balances artisan protection with market competitiveness.`;

  return `${productionCostText} ${fairFloorText} ${marketText} ${recommendationText}${materialCostNote ? ` ${materialCostNote}` : ""}`;
}

export function calculateSmartPrice(input: PricingEngineInput): PricingEngineOutput {
  if (!input.category || !input.category.trim()) {
    throw new Error("Category is required");
  }

  let effectiveMaterialCost = 0;
  if (Array.isArray(input.rawMaterials) && input.rawMaterials.length > 0) {
    effectiveMaterialCost = input.rawMaterials.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
  } else if (typeof input.materialCost === "number" && input.materialCost > 0) {
    effectiveMaterialCost = input.materialCost;
  }

  if (effectiveMaterialCost <= 0) {
    throw new Error("Material cost must be greater than 0");
  }

  const normalizedCategory = input.category.toLowerCase();
  const categoryConfig = CATEGORY_DATASET[normalizedCategory];
  if (!categoryConfig) {
    throw new Error("Unsupported category");
  }
  const categoryName = categoryConfig.name;

  const materialCostAssessment = assessMaterialCost(normalizedCategory, effectiveMaterialCost);
  const materialCostForCalculation = materialCostAssessment.materialCostUsedForCalculation;

  const fullText = `${input.category} ${input.descriptionEn || ""} ${input.descriptionHi || ""}`.trim();

  let complexity: ComplexityLevel;
  let complexitySource: "explicit" | "inferred" | "invalid-fallback";
  if (input.complexity !== undefined) {
    if (isValidComplexity(input.complexity)) {
      complexity = input.complexity;
      complexitySource = "explicit";
    } else {
      complexity = "standard";
      complexitySource = "invalid-fallback";
    }
  } else {
    complexity = inferComplexity(fullText);
    complexitySource = "inferred";
  }

  const labourFactor = PRICING_CONFIG.labourFactors[complexity];
  const estimatedLabourCost = materialCostForCalculation * labourFactor;
  const overhead = (materialCostForCalculation + estimatedLabourCost) * PRICING_CONFIG.overheadRate;
  const productionCost = materialCostForCalculation + estimatedLabourCost + overhead;
  const fairPriceFloor = productionCost * (1 + PRICING_CONFIG.fairMargin);

  const selectedSubcategory = input.subcategory || inferSubcategory(normalizedCategory, fullText);
  const catMarket = MARKET_REFERENCE[normalizedCategory];
  const marketData: MarketBenchmark | undefined = selectedSubcategory && catMarket ? catMarket[selectedSubcategory] : undefined;

  const marketAvailable = Boolean(marketData);
  const marketMin = marketData ? marketData.marketMin : null;
  const marketMedian = marketData ? marketData.marketMedian : null;
  const marketMax = marketData ? marketData.marketMax : null;
  const sampleCount = marketData ? marketData.sampleCount : 0;
  const sourceCount = marketData ? marketData.sourceCount : 0;

  const marketWeight = getMarketWeight(marketAvailable, sampleCount);
  const costWeight = 1 - marketWeight;

  const rawRecommendedPrice =
    marketAvailable && marketMedian !== null
      ? Math.max(fairPriceFloor, costWeight * fairPriceFloor + marketWeight * marketMedian)
      : fairPriceFloor;

  const rawMinimumPrice = fairPriceFloor;

  const rawMaximumCandidate = rawRecommendedPrice * (1 + PRICING_CONFIG.maximumMarkup);
  const rawMaximumPrice =
    marketAvailable && marketMax !== null
      ? Math.max(rawRecommendedPrice, Math.min(marketMax, rawMaximumCandidate))
      : rawMaximumCandidate;

  const minimumPrice = roundToSensibleInr(rawMinimumPrice);
  const recommendedPrice = roundToSensibleInr(rawRecommendedPrice);
  const maximumPrice = roundToSensibleInr(rawMaximumPrice);

  const marketEvidenceScore = !marketAvailable ? 0 : sampleCount >= 20 ? 40 : sampleCount >= 10 ? 30 : sampleCount >= 5 ? 20 : 10;

  const hasImage = Boolean(input.imageUrl && input.imageUrl.startsWith("http"));
  const descText = (input.descriptionEn || input.descriptionHi || "").trim();
  const hasUsefulDescription = descText.length >= 15;
  const hasAnyDescription = descText.length > 0;
  const productIdentificationScore = hasImage && hasUsefulDescription
    ? 30
    : hasImage || hasUsefulDescription
    ? 20
    : hasAnyDescription
    ? 10
    : 0;

  const costEstimateScore = complexitySource === "explicit" ? 30 : complexitySource === "inferred" ? 20 : 10;

  const recommendationReliability = Math.max(
    0,
    Math.min(100, marketEvidenceScore + productIdentificationScore + costEstimateScore)
  );

  let reliabilityLabel: PricingEngineOutput["reliabilityLabel"] = "Medium";
  if (recommendationReliability >= 90) reliabilityLabel = "Very High";
  else if (recommendationReliability >= 75) reliabilityLabel = "High";
  else if (recommendationReliability >= 60) reliabilityLabel = "Medium";
  else if (recommendationReliability >= 40) reliabilityLabel = "Low";
  else reliabilityLabel = "Very Low";

  const reason = buildExplanation({
    productionCost,
    fairPriceFloor,
    marketAvailable,
    marketMedian,
    sampleCount,
    recommendedPrice,
    materialCostAssessment,
    categoryName,
  });

  const overchargeCeiling = roundToSensibleInr(maximumPrice * (1 + PRICING_CONFIG.overchargeThreshold));

  return {
    success: true,
    suggestedMin: minimumPrice,
    suggestedMax: maximumPrice,
    minimumPrice,
    recommendedPrice,
    maximumPrice,
    reason,
    reasoning: reason,
    recommendationReliability,
    reliabilityLabel,
    overchargeCeiling,
    materialCostAssessment,
    pricingBreakdown: {
      materialCost: effectiveMaterialCost,
      materialCostUsedForCalculation: roundToSensibleInr(materialCostForCalculation),
      estimatedLabourCost: roundToSensibleInr(estimatedLabourCost),
      overhead: roundToSensibleInr(overhead),
      productionCost: roundToSensibleInr(productionCost),
      fairPriceFloor: roundToSensibleInr(fairPriceFloor),
      marketMedian,
      marketWeight,
      costWeight,
      complexity,
      subcategory: selectedSubcategory,
      categoryName,
    },
    marketReference: {
      available: marketAvailable,
      min: marketMin,
      median: marketMedian,
      max: marketMax,
      sampleCount,
      sourceCount,
    },
    assumptions: {
      labourFactor,
      overheadRate: PRICING_CONFIG.overheadRate,
      fairMargin: PRICING_CONFIG.fairMargin,
    },
  };
}
