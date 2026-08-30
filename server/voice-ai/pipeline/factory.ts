import { VoiceAiDependencies, VoiceAiLogger } from "../types/voice-ai.types";
import { GeminiSttService } from "../stt/gemini-stt.service";
import { GeminiTranslationService } from "../translation/gemini-translation.service";
import { MockTranslationService } from "../translation/mock-translation.service";
import { GeminiDescriptionService } from "../description/gemini-description.service";
import { loadEnv } from "../config/env";

export interface BuildDependenciesOptions {
  logger?: VoiceAiLogger;
  forceMockTranslation?: boolean;
}

export function buildVoiceAiDependencies(options: BuildDependenciesOptions = {}): VoiceAiDependencies {
  const env = loadEnv();

  return {
    sttService: new GeminiSttService(env),
    descriptionService: new GeminiDescriptionService(env),
    translationService: options.forceMockTranslation
      ? new MockTranslationService()
      : new GeminiTranslationService(env),
    logger: options.logger,
  };
}
