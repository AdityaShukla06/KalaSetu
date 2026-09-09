import { TranslationService, DetectedTranslation, SupportedLanguageCode } from "../types/voice-ai.types";
import { TranslationFailedError } from "../errors/voice-ai.errors";

/**
 * Local-only mock translation service. Makes no network calls, so the
 * pipeline and its tests can run without credentials. It deterministically
 * tags the text rather than translating, so tests can assert the language
 * pair and manual runs make it obvious this is not a real translation.
 */
export class MockTranslationService implements TranslationService {
  constructor(private readonly failOnLanguagePair?: { source: SupportedLanguageCode; target: SupportedLanguageCode }) {}

  async translate(
    text: string,
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<string> {
    if (sourceLanguage === targetLanguage) return text;

    if (
      this.failOnLanguagePair &&
      this.failOnLanguagePair.source === sourceLanguage &&
      this.failOnLanguagePair.target === targetLanguage
    ) {
      throw new TranslationFailedError(`Simulated failure for ${sourceLanguage} -> ${targetLanguage}`);
    }

    return `[mock:${sourceLanguage}->${targetLanguage}] ${text}`;
  }

  async detectAndTranslate(
    text: string,
    targetLanguage: SupportedLanguageCode,
    sourceHint?: string,
  ): Promise<DetectedTranslation> {
    return {
      translation: `[mock:auto->${targetLanguage}] ${text}`,
      detectedLanguage: sourceHint ?? "en",
    };
  }
}
