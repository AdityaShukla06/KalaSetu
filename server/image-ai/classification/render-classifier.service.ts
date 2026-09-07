import {
  ClassificationSource,
  CraftClassification,
  CraftClassifierService,
} from "../types/classification.types";
import { normaliseCategory, normaliseMaterial } from "./normalise";

interface RenderPredictionResponse {
  predicted_category?: unknown;
  confidence_score?: unknown;
  requires_review?: unknown;
  artisan_metadata?: { materials?: unknown } | null;
}

export class RenderClassifierService implements CraftClassifierService {
  readonly source: ClassificationSource = "render";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async warmUp(): Promise<void> {
    await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async classify(image: Buffer, mimeType: string): Promise<CraftClassification> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(image)], { type: mimeType }), "photo.jpg");

    const response = await fetch(`${this.baseUrl}/predict`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Craft classifier returned ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as RenderPredictionResponse;

    const category = normaliseCategory(payload.predicted_category);
    if (!category) {
      throw new Error(`Craft classifier returned an unknown category: ${String(payload.predicted_category)}`);
    }

    return {
      category,
      confidence: confidenceFrom(payload),
      material: normaliseMaterial(category, payload.artisan_metadata?.materials),
      source: this.source,
    };
  }
}

function confidenceFrom(payload: RenderPredictionResponse): CraftClassification["confidence"] {
  if (payload.requires_review === true) return "low";

  const score = typeof payload.confidence_score === "number" ? payload.confidence_score : undefined;
  if (score === undefined) return payload.requires_review === false ? "high" : "low";

  if (score >= 0.75) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}
