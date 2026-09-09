import { VoiceAiDependencies, VoiceAiLogger } from "../types/voice-ai.types";
import { GroqSttService } from "../stt/groq-stt.service";
import { GroqTranslationService } from "../translation/groq-translation.service";
import { GroqDescriptionService } from "../description/groq-description.service";
import { GeminiSttService } from "../stt/gemini-stt.service";
import { GeminiTranslationService } from "../translation/gemini-translation.service";
import { GeminiDescriptionService } from "../description/gemini-description.service";
import { MockTranslationService } from "../translation/mock-translation.service";
import { BhashiniSttService } from "../stt/bhashini-stt.service";
import { ChainSttService } from "../stt/chain-stt.service";
import { isBhashiniConfigured } from "../bhashini/configCache";
import { loadEnv } from "../config/env";

export interface BuildDependenciesOptions {
  logger?: VoiceAiLogger;
  forceMockTranslation?: boolean;
}

export function buildVoiceAiDependencies(options: BuildDependenciesOptions = {}): VoiceAiDependencies {
  const env = loadEnv();

  if (env.VOICE_AI_PROVIDER === "gemini") {
    return {
      sttService: new GeminiSttService(env as Required<typeof env>),
      descriptionService: new GeminiDescriptionService(env as Required<typeof env>),
      translationService: options.forceMockTranslation
        ? new MockTranslationService()
        : new GeminiTranslationService(env as Required<typeof env>),
      logger: options.logger,
    };
  }

  const groqStt = new GroqSttService(env);
  const bhashiniEnabled = env.BHASHINI_STT_ENABLED ?? isBhashiniConfigured(env);

  return {
    sttService: bhashiniEnabled
      ? new ChainSttService(new BhashiniSttService(env), groqStt, options.logger)
      : groqStt,
    descriptionService: new GroqDescriptionService(env),
    translationService: options.forceMockTranslation
      ? new MockTranslationService()
      : new GroqTranslationService(env),
    logger: options.logger,
  };
}
