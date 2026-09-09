import {
  TranslationService,
  DetectedTranslation,
  SupportedLanguageCode,
  SUPPORTED_LANGUAGES,
} from "../types/voice-ai.types";
import { TranslationFailedError, MalformedModelResponseError } from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";
import { groqChat } from "../groq/chat";
import { GroqKeyPool, collectGroqApiKeys } from "../groq/keyPool";

export class GroqTranslationService implements TranslationService {
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
        keyPool: this.keyPool,
        model: this.model,
        fallbackModel: this.fallbackModel,
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

  async detectAndTranslate(
    text: string,
    targetLanguage: SupportedLanguageCode,
    sourceHint?: string,
  ): Promise<DetectedTranslation> {
    const targetName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.englishName ?? targetLanguage;
    const hintName = SUPPORTED_LANGUAGES.find((l) => l.code === sourceHint)?.englishName;

    let raw: string;
    try {
      raw = await groqChat({
        keyPool: this.keyPool,
        model: this.model,
        fallbackModel: this.fallbackModel,
        json: true,
        prompt: buildDetectPrompt(text, targetName, hintName),
      });
    } catch (err) {
      throw new TranslationFailedError(`Translation into ${targetLanguage} failed`, err);
    }

    let parsed: { translation?: string; sourceLanguageCode?: string };
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError(
        "translation",
        "Translation response was not valid JSON",
        parseErr,
      );
    }

    const translation = parsed.translation?.trim();
    if (!translation) {
      throw new TranslationFailedError(`Empty translation output for ${targetName}`);
    }

    const claimed = parsed.sourceLanguageCode?.trim().toLowerCase();
    const detectedLanguage = SUPPORTED_LANGUAGES.some((l) => l.code === claimed) ? (claimed as string) : "";

    return { translation, detectedLanguage };
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

function buildDetectPrompt(text: string, targetName: string, hintName?: string): string {
  const codes = SUPPORTED_LANGUAGES.map((l) => `${l.code} (${l.englishName})`).join(", ");
  const hint = hintName
    ? `\nThe writer's app was set to ${hintName}, which is a hint only. Trust the message itself over the hint.\n`
    : "";

  return `A person wrote the message below in one of these languages: ${codes}.

Work out which one it is, then translate the message into natural ${targetName}.
${hint}
Rules:
1. The message may be romanised, meaning an Indian language typed in Latin letters rather than its own
   script (for example "kitne din lagenge" is Hindi, "enthu vela" is Telugu, "koto din lagbe" is Bengali).
   Judge the language by the words themselves, not by the script they are written in. Report the language
   the words belong to, never Latin or English, unless the words really are English.
2. Preserve the exact meaning. Add nothing, drop nothing.
3. Do not add commentary, notes, or markup.
4. Write ${targetName} in its own script.
5. If the message already reads naturally as ${targetName} in its own script, return it unchanged.
6. Report the source language as one of the codes listed above, and nothing else.

Message:
"""${text}"""

Respond with a JSON object of the form {"sourceLanguageCode": "..", "translation": ".."}.`;
}
