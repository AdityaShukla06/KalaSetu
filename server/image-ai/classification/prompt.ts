import { CRAFT_CATEGORY_IDS, PRODUCT_MATERIALS } from "../../../shared/materials";

export const CLASSIFICATION_CONFIDENCES = ["high", "medium", "low"] as const;

export function buildClassificationPrompt(): string {
  return `You are looking at a photograph of a handmade product by an Indian artisan, taken so it can be listed for sale.

Pick the single category that best describes the product in the photo, from exactly this list:
${CRAFT_CATEGORY_IDS.join(", ")}

Rules:
1. Judge only what is visible in the photo. Do not guess at anything outside the frame.
2. Use "other" when the product genuinely fits none of the named categories, not as a way to avoid deciding.
3. Report confidence as "high" when the craft is unmistakable, "medium" when the photo is workable but the craft is partly ambiguous, and "low" when the photo is blurred, dark, cluttered, or shows several unrelated items.
4. Optionally name the dominant material, from exactly this list: ${PRODUCT_MATERIALS.join(", ")}. Omit the material entirely rather than guessing at one.

Respond with a JSON object of the form {"category": "...", "confidence": "...", "material": "..."}.`;
}
