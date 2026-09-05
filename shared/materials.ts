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
