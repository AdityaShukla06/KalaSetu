import { TranslationService, SupportedLanguageCode } from "../types/voice-ai.types";
import { TranslationFailedError } from "../errors/voice-ai.errors";

/**
 * Local-only mock translation service. Does NOT call any external API — it
 * exists purely so the pipeline, tests, and eval harness can run end-to-end
 * before BHASHINI credentials are issued (Phase 1).
 *
 * It does not attempt real translation quality; it deterministically tags
 * the text so tests can assert that the correct language pair was
 * requested, and to make it visually obvious in manual testing that this is
 * NOT a real translation.
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
}
