import { GoogleGenAI } from "@google/genai";
import { ProductDescriptionService } from "../types/voice-ai.types";
import { DescriptionGenerationError, MalformedModelResponseError } from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";

/**
 * Generates the final English product description from the English
 * transcript + category, using gemini-3.5-flash (Flash tier — this is plain
 * text generation, not agentic/coding work, so the cheaper 3.5 tier is
 * appropriate; gemini-2.5-flash is scheduled for shutdown Oct 16 2026, and
 * 3.6/3.7 Flash are priced for heavier agentic workloads this task doesn't need).
 *
 * Uses structured JSON output (`responseSchema`) so the result is always a
 * single, predictable field rather than free-form text that needs parsing.
 */
export class GeminiDescriptionService implements ProductDescriptionService {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(env: Pick<VoiceAiEnv, "GEMINI_API_KEY" | "GEMINI_FLASH_MODEL">) {
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    this.model = env.GEMINI_FLASH_MODEL;
  }

  async generateDescription(englishTranscript: string, category: string): Promise<string> {
    if (!englishTranscript || englishTranscript.trim().length === 0) {
      throw new DescriptionGenerationError("Cannot generate a description from an empty transcript");
    }

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt(englishTranscript, category) }],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              descriptionEn: { type: "STRING" },
            },
            required: ["descriptionEn"],
          },
        },
      });

      const raw = response.text;
      if (!raw) {
        throw new MalformedModelResponseError("generation", "Gemini returned no text output");
      }

      let parsed: { descriptionEn?: string };
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        throw new MalformedModelResponseError("generation", "Gemini response was not valid JSON", parseErr);
      }

      if (!parsed.descriptionEn || parsed.descriptionEn.trim().length === 0) {
        throw new MalformedModelResponseError("generation", "Gemini response was missing descriptionEn");
      }

      return parsed.descriptionEn.trim();
    } catch (err) {
      if (err instanceof MalformedModelResponseError) throw err;
      throw new DescriptionGenerationError("Gemini description generation call failed", err);
    }
  }
}

/**
 * Production prompt. Every constraint below maps directly to a requirement
 * from the project brief: use ONLY stated facts, never invent materials,
 * dimensions, price, location, certifications, history, or quality/cultural
 * claims (eco-friendly, traditional, generations-old, etc.) unless the
 * artisan actually said them.
 */
function buildPrompt(englishTranscript: string, category: string): string {
  return `You are writing a short e-commerce product description for an Indian artisan marketplace (KalaSetu).

You will be given:
- category: the product category the artisan selected
- transcript: an English translation of the artisan describing their own product in their own words

Your task: write ONE concise, natural-sounding English product description (1-3 sentences) for this listing.

STRICT RULES — follow every one of these:
1. Use ONLY information explicitly present in the transcript. Do not add anything the artisan did not say.
2. Do NOT invent or assume: materials, dimensions/size, price, location/region, certifications, historical or cultural claims (e.g. "traditional", "passed down through generations"), quality claims (e.g. "premium", "finest"), or environmental claims (e.g. "eco-friendly", "sustainable", "100% natural") unless the transcript states them directly.
3. Do NOT assume properties just because of the category (e.g. do not assume a "basket" category item is bamboo, or that a "textile" is cotton, unless the artisan said so).
4. If the transcript is vague or sparse, write a short, honest, equally sparse description rather than padding it with invented detail.
5. Preserve the specific details the artisan DID give (materials, use, technique, color, etc. if mentioned).
6. Write in natural e-commerce language — not a literal translation, not a list of keywords, not overly flowery.
7. Do not mention the artisan speaking, transcripts, translation, or the AI process — write only the product description itself.

category: ${category}
transcript: """${englishTranscript}"""

Respond with a JSON object of the form {"descriptionEn": "..."}.`;
}
