import { TranslationService, SupportedLanguageCode, SUPPORTED_LANGUAGES } from "../types/voice-ai.types";
import { TranslationFailedError, MalformedModelResponseError } from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";
import { groqChat } from "../groq/chat";

export class GroqTranslationService implements TranslationService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(env: Pick<VoiceAiEnv, "GROQ_API_KEY" | "GROQ_LLM_MODEL">) {
    if (!env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.apiKey = env.GROQ_API_KEY;
    this.model = env.GROQ_LLM_MODEL;
  }

  async translate(
    text: string,
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<string> {
    if (sourceLanguage === targetLanguage || !text || text.trim().length === 0) {
      return text;
    }

    const sourceName = SUPPORTED_LANGUAGES.find((l) => l.code === sourceLanguage)?.englishName ?? sourceLanguage;
    const targetName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.englishName ?? targetLanguage;

    let raw: string;
    try {
      raw = await groqChat({
        apiKey: this.apiKey,
        model: this.model,
        json: true,
        prompt: buildPrompt(text, sourceName, targetName),
      });
    } catch (err) {
      throw new TranslationFailedError(
        `Translation failed for ${sourceLanguage} to ${targetLanguage}`,
        err,
      );
    }

    let parsed: { translation?: string };
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError(
        "translation",
        "Translation response was not valid JSON",
        parseErr,
      );
    }

    const translated = parsed.translation?.trim();
    if (!translated) {
      throw new TranslationFailedError(
        `Empty translation output from ${sourceName} to ${targetName}`,
      );
    }

    return translated;
  }
}

function buildPrompt(text: string, sourceName: string, targetName: string): string {
  return `Translate the following artisan product text from ${sourceName} into natural ${targetName}.

Rules:
1. Preserve the exact meaning, materials, and craft terminology.
2. Add nothing that is not in the original, and drop nothing that is.
3. Do not add commentary, notes, or markup.
4. Write ${targetName} in its own script.

Original text:
"""${text}"""

Respond with a JSON object of the form {"translation": "..."}.`;
}
