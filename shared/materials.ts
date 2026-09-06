export const PRODUCT_MATERIALS: string[] = [
  "Cotton",
  "Silk",
  "Wool",
  "Jute",
  "Linen",
  "Clay",
  "Terracotta",
  "Wood",
  "Bamboo",
  "Cane",
  "Brass",
  "Copper",
  "Bronze",
  "Silver",
  "Iron",
  "Stone",
  "Leather",
  "Glass",
  "Paper",
  "Other",
];

const MATERIAL_SET = new Set(PRODUCT_MATERIALS);

export function isProductMaterial(value: string): boolean {
  return MATERIAL_SET.has(value);
}

export const CATEGORY_MATERIALS: Record<string, string[]> = {
  textiles: ["Cotton", "Silk", "Wool", "Jute", "Linen", "Other"],
  pottery: ["Clay", "Terracotta", "Stone", "Other"],
  jewelry: ["Silver", "Brass", "Copper", "Bronze", "Stone", "Glass", "Other"],
  woodwork: ["Wood", "Bamboo", "Cane", "Other"],
  "bamboo-cane": ["Bamboo", "Cane", "Wood", "Other"],
  other: PRODUCT_MATERIALS,
};

export function materialsForCategory(category: string): string[] {
  return CATEGORY_MATERIALS[category] ?? PRODUCT_MATERIALS;
}
