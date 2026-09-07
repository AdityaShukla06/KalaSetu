export type ClassificationConfidence = "high" | "medium" | "low";

export type ClassificationSource = "gemini" | "groq" | "render";

export interface CraftClassification {
  category: string;
  confidence: ClassificationConfidence;
  material?: string;
  source: ClassificationSource;
}

export interface CraftClassifierService {
  readonly source: ClassificationSource;
  classify(image: Buffer, mimeType: string): Promise<CraftClassification>;
}
