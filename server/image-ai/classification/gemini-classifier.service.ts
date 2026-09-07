import { GoogleGenAI } from "@google/genai";
import { CRAFT_CATEGORY_IDS, PRODUCT_MATERIALS } from "../../../shared/materials";
import {
  ClassificationSource,
  CraftClassification,
  CraftClassifierService,
} from "../types/classification.types";
import { CLASSIFICATION_CONFIDENCES, buildClassificationPrompt } from "./prompt";
import { normaliseCategory, normaliseMaterial } from "./normalise";

export class GeminiClassifierService implements CraftClassifierService {
  readonly source: ClassificationSource = "gemini";

  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string, timeoutMs: number) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async classify(image: Buffer, mimeType: string): Promise<CraftClassification> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { data: image.toString("base64"), mimeType } },
            { text: buildClassificationPrompt() },
          ],
        },
      ],
      config: {
        temperature: 0,
        abortSignal: AbortSignal.timeout(this.timeoutMs),
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING", enum: CRAFT_CATEGORY_IDS },
            confidence: { type: "STRING", enum: [...CLASSIFICATION_CONFIDENCES] },
            material: { type: "STRING", enum: PRODUCT_MATERIALS },
          },
          required: ["category", "confidence"],
        },
      },
    });

    const raw = response.text;
    if (!raw) {
      throw new Error("Gemini returned an empty classification response");
    }

    const parsed = JSON.parse(raw) as { category?: unknown; confidence?: unknown; material?: unknown };

    const category = normaliseCategory(parsed.category);
    if (!category) {
      throw new Error(`Gemini returned an unknown category: ${String(parsed.category)}`);
    }

    const confidence = CLASSIFICATION_CONFIDENCES.find((entry) => entry === parsed.confidence) ?? "low";

    return {
      category,
      confidence,
      material: normaliseMaterial(category, parsed.material),
      source: this.source,
    };
  }
}
