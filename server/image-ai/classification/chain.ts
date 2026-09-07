import { CraftClassification, CraftClassifierService } from "../types/classification.types";

export async function classifyWithChain(
  providers: readonly CraftClassifierService[],
  image: Buffer,
  mimeType: string,
): Promise<CraftClassification | null> {
  for (const provider of providers) {
    try {
      return await provider.classify(image, mimeType);
    } catch (err) {
      console.warn("[image-ai] craft classifier tier failed, trying the next one", {
        source: provider.source,
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
    }
  }

  return null;
}
