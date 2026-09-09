import { GoogleGenAI } from "@google/genai";
import {
  TranslationService,
  DetectedTranslation,
  SupportedLanguageCode,
  SUPPORTED_LANGUAGES,
} from "../types/voice-ai.types";
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

    const sourceName = SUPPORTED_LANGUAGES.find((l) => l.code === sourceLanguage)?.englishName || sourceLanguage;
    const targetName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.englishName || targetLanguage;

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

  async detectAndTranslate(
    text: string,
    targetLanguage: SupportedLanguageCode,
    sourceHint?: string,
  ): Promise<DetectedTranslation> {
    const targetName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.englishName || targetLanguage;
    const codes = SUPPORTED_LANGUAGES.map((l) => `${l.code} (${l.englishName})`).join(", ");
    const hintName = SUPPORTED_LANGUAGES.find((l) => l.code === sourceHint)?.englishName;
    const hint = hintName
      ? `The writer's app was set to ${hintName}, which is a hint only. Trust the message itself over the hint.\n`
      : "";

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  `A person wrote the message below in one of these languages: ${codes}.\n` +
                  `Work out which one it is, then translate the message into natural ${targetName}.\n` +
                  hint +
                  `The message may be romanised, meaning an Indian language typed in Latin letters rather than its own script ` +
                  `(for example "kitne din lagenge" is Hindi, "enthu vela" is Telugu, "koto din lagbe" is Bengali). Judge the ` +
                  `language by the words themselves, not the script, and never report Latin or English unless the words really ` +
                  `are English.\n` +
                  `Preserve the exact meaning without adding commentary or markup, and write ${targetName} in its own script.\n` +
                  `If the message already reads naturally as ${targetName} in its own script, return it unchanged.\n` +
                  `Report the source language as one of the codes listed above.\n\n` +
                  `Message:\n"""${text}"""\n\n` +
                  `Respond with only a JSON object of the form {"sourceLanguageCode": "..", "translation": ".."}.`,
              },
            ],
          },
        ],
        config: { responseMimeType: "application/json" },
      });

      const raw = response.text?.trim();
      if (!raw) {
        throw new TranslationFailedError(`Empty translation output for ${targetName}`);
      }

      const parsed = JSON.parse(raw) as { translation?: string; sourceLanguageCode?: string };
      const translation = parsed.translation?.trim();
      if (!translation) {
        throw new TranslationFailedError(`Empty translation output for ${targetName}`);
      }

      const claimed = parsed.sourceLanguageCode?.trim().toLowerCase();
      const detectedLanguage = SUPPORTED_LANGUAGES.some((l) => l.code === claimed) ? (claimed as string) : "";

      return { translation, detectedLanguage };
    } catch (err: any) {
      if (err instanceof TranslationFailedError) throw err;
      throw new TranslationFailedError(`Gemini translation into ${targetLanguage} failed`, err);
    }
  }
}
