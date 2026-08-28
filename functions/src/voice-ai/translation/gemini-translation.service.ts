import { GoogleGenAI } from "@google/genai";
import { TranslationService, SupportedLanguageCode, SUPPORTED_LANGUAGES } from "../types/voice-ai.types";
import { TranslationFailedError } from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";

export class GeminiTranslationService implements TranslationService {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(env: Pick<VoiceAiEnv, "GEMINI_API_KEY" | "GEMINI_FLASH_MODEL">) {
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    this.model = env.GEMINI_FLASH_MODEL;
  }

  async translate(
    text: string,
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<string> {
    if (sourceLanguage === targetLanguage || !text || text.trim().length === 0) {
      return text;
    }

    const sourceName = SUPPORTED_LANGUAGES.find((l) => l.code === sourceLanguage)?.name || sourceLanguage;
    const targetName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.name || targetLanguage;

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  `Translate the following artisan product text accurately from ${sourceName} to natural ${targetName}.\n` +
                  `Preserve the exact meaning, materials, and artisan terminology without adding any extra commentary or markup.\n\n` +
                  `Original Text:\n"""${text}"""\n\n` +
                  `Translated ${targetName} Text:`,
              },
            ],
          },
        ],
      });

      const translated = response.text?.trim();
      if (!translated) {
        throw new TranslationFailedError(`Empty translation output from ${sourceName} to ${targetName}`);
      }

      return translated;
    } catch (err: any) {
      if (err instanceof TranslationFailedError) throw err;
      throw new TranslationFailedError(`Gemini translation failed for ${sourceLanguage} -> ${targetLanguage}`, err);
    }
  }
}
