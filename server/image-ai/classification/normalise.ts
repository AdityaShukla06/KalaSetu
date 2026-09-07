import { isCraftCategory, materialsForCategory } from "../../../shared/materials";

const RENDER_LABEL_TO_CATEGORY: Record<string, string> = {
  "bamboo & cane": "bamboo-cane",
  "bamboo and cane": "bamboo-cane",
  "bamboo-cane": "bamboo-cane",
  jewelry: "jewelry",
  jewellery: "jewelry",
  pottery: "pottery",
  textiles: "textiles",
  woodwork: "woodwork",
  other: "other",
};

export function normaliseCategory(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const mapped = RENDER_LABEL_TO_CATEGORY[trimmed.toLowerCase()];
  if (mapped) return mapped;

  return isCraftCategory(trimmed) ? trimmed : undefined;
}

export function normaliseMaterial(category: string, raw: unknown): string | undefined {
  const candidates: unknown[] = Array.isArray(raw) ? raw : [raw];
  const allowed = materialsForCategory(category);

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const needle = candidate.trim().toLowerCase();
    if (needle === "" || needle === "other") continue;

    const match = allowed.find((entry) => entry.toLowerCase() === needle);
    if (match && match !== "Other") return match;
  }

  return undefined;
}
