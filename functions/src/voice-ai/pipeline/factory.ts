import { VoiceAiDependencies, VoiceAiLogger } from "../types/voice-ai.types";
import { GeminiSttService } from "../stt/gemini-stt.service";
import { BhashiniTranslationService } from "../translation/bhashini.service";
import { GeminiTranslationService } from "../translation/gemini-translation.service";
import { MockTranslationService } from "../translation/mock-translation.service";
import { GeminiDescriptionService } from "../description/gemini-description.service";
import { loadEnv, hasBhashiniCredentials } from "../config/env";

export interface BuildDependenciesOptions {
  logger?: VoiceAiLogger;
  forceMockTranslation?: boolean;
}

export function buildVoiceAiDependencies(options: BuildDependenciesOptions = {}): VoiceAiDependencies {
  const env = loadEnv();

  const sttService = new GeminiSttService(env);
  const descriptionService = new GeminiDescriptionService(env);

  let translationService;
  if (options.forceMockTranslation) {
    translationService = new MockTranslationService();
  } else if (hasBhashiniCredentials(env)) {
    translationService = new BhashiniTranslationService({
      userId: env.BHASHINI_ULCA_USER_ID!,
      apiKey: env.BHASHINI_ULCA_API_KEY!,
      pipelineId: env.BHASHINI_PIPELINE_ID!,
    });
  } else {
    // Real translation using Gemini Flash when BHASHINI keys are not yet provided
    translationService = new GeminiTranslationService(env);
  }

  return {
    sttService,
    translationService,
    descriptionService,
    logger: options.logger,
  };
}
