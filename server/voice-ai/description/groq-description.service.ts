import { ProductDescriptionService, HeritageStoryInput } from "../types/voice-ai.types";
import { DescriptionGenerationError, MalformedModelResponseError } from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";
import { groqChat } from "../groq/chat";
import { GroqKeyPool, collectGroqApiKeys } from "../groq/keyPool";
import { buildHeritagePrompt } from "./heritagePrompt";

export class GroqDescriptionService implements ProductDescriptionService {
  private readonly keyPool: GroqKeyPool;
  private readonly model: string;
  private readonly fallbackModel: string;

  constructor(
    env: Pick<VoiceAiEnv, "GROQ_API_KEY" | "GROQ_LLM_MODEL" | "GROQ_LLM_FALLBACK_MODEL"> &
      Partial<Pick<VoiceAiEnv, "GROQ_API_KEY_2" | "GROQ_API_KEY_3" | "GROQ_FALLBACK_API_KEYS">>,
  ) {
    const keys = collectGroqApiKeys(env);
    if (keys.length === 0) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.keyPool = new GroqKeyPool(keys);
    this.model = env.GROQ_LLM_MODEL;
    this.fallbackModel = env.GROQ_LLM_FALLBACK_MODEL;
  }

  async generateDescription(englishTranscript: string, category: string): Promise<string> {
    if (!englishTranscript || englishTranscript.trim().length === 0) {
      throw new DescriptionGenerationError("Cannot generate a description from an empty transcript");
    }

    let raw: string;
    try {
      raw = await groqChat({
        keyPool: this.keyPool,
        model: this.model,
        fallbackModel: this.fallbackModel,
        json: true,
        prompt: buildPrompt(englishTranscript, category),
      });
    } catch (err) {
      throw new DescriptionGenerationError("Description generation call failed", err);
    }

    let parsed: { descriptionEn?: string };
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError(
        "generation",
        "Description response was not valid JSON",
        parseErr,
      );
    }

    const description = parsed.descriptionEn?.trim();
    if (!description) {
      throw new MalformedModelResponseError("generation", "Response was missing descriptionEn");
    }

    return description;
  }

  async generateHeritageStory(input: HeritageStoryInput): Promise<string> {
    if (!input.descriptionEn || input.descriptionEn.trim().length === 0) {
      throw new DescriptionGenerationError("Cannot generate a heritage story from an empty description");
    }

    let raw: string;
    try {
      raw = await groqChat({
        keyPool: this.keyPool,
        model: this.model,
        fallbackModel: this.fallbackModel,
        json: true,
        prompt: buildHeritagePrompt(input),
      });
    } catch (err) {
      throw new DescriptionGenerationError("Heritage story generation call failed", err);
    }

    let parsed: { story?: string };
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError("generation", "Heritage story response was not valid JSON", parseErr);
    }

    const story = parsed.story?.trim();
    if (!story) {
      throw new MalformedModelResponseError("generation", "Response was missing story");
    }

    return story;
  }
}

function buildPrompt(englishTranscript: string, category: string): string {
  return `You are writing a short e-commerce product description for an Indian artisan marketplace (KalaSetu).

You will be given:
- category: the product category the artisan selected
- transcript: an English translation of the artisan describing their own product in their own words

Your task: write ONE concise, natural-sounding English product description (1-3 sentences) for this listing.

STRICT RULES, follow every one of these:
1. Use ONLY information explicitly present in the transcript. Do not add anything the artisan did not say.
2. Do NOT invent or assume: materials, dimensions/size, price, location/region, certifications, historical or cultural claims (e.g. "traditional", "passed down through generations"), quality claims (e.g. "premium", "finest"), or environmental claims (e.g. "eco-friendly", "sustainable", "100% natural") unless the transcript states them directly.
3. Do NOT assume properties just because of the category (e.g. do not assume a "basket" category item is bamboo, or that a "textile" is cotton, unless the artisan said so).
4. If the transcript is vague or sparse, write a short, honest, equally sparse description rather than padding it with invented detail.
5. Preserve the specific details the artisan DID give (materials, use, technique, color, etc. if mentioned).
6. Write in natural e-commerce language, not a literal translation, not a list of keywords, not overly flowery.
7. Do not mention the artisan speaking, transcripts, translation, or the AI process. Write only the product description itself.

category: ${category}
transcript: """${englishTranscript}"""

Respond with a JSON object of the form {"descriptionEn": "..."}.`;
}
