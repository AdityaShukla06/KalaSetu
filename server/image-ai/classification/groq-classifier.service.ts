import { GroqKeyPool } from "../../voice-ai/groq/keyPool";
import { groqChat } from "../../voice-ai/groq/chat";
import {
  ClassificationSource,
  CraftClassification,
  CraftClassifierService,
} from "../types/classification.types";
import { CLASSIFICATION_CONFIDENCES, buildClassificationPrompt } from "./prompt";
import { normaliseCategory, normaliseMaterial } from "./normalise";

export class GroqClassifierService implements CraftClassifierService {
  readonly source: ClassificationSource = "groq";

  private readonly keyPool: GroqKeyPool;
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly timeoutMs: number;

  constructor(keyPool: GroqKeyPool, model: string, fallbackModel: string, timeoutMs: number) {
    this.keyPool = keyPool;
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.timeoutMs = timeoutMs;
  }

  async classify(image: Buffer, mimeType: string): Promise<CraftClassification> {
    const raw = await groqChat({
      keyPool: this.keyPool,
      model: this.model,
      fallbackModel: this.fallbackModel,
      prompt: buildClassificationPrompt(),
      imageDataUrl: `data:${mimeType};base64,${image.toString("base64")}`,
      json: true,
      timeoutMs: this.timeoutMs,
    });

    const parsed = JSON.parse(raw) as { category?: unknown; confidence?: unknown; material?: unknown };

    const category = normaliseCategory(parsed.category);
    if (!category) {
      throw new Error(`Groq returned an unknown category: ${String(parsed.category)}`);
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
