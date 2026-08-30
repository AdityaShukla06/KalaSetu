export * from "./types/voice-ai.types";
export * from "./errors/voice-ai.errors";
export { loadEnv } from "./config/env";

export { processVoiceDescription } from "./pipeline/voice-product-pipeline";
export { buildVoiceAiDependencies } from "./pipeline/factory";

export { normaliseAudioMimeType, extensionForAudio } from "./stt/audio-mime";
export { GroqSttService, GROQ_SUPPORTED_AUDIO_TYPES, toSupportedLanguage } from "./stt/groq-stt.service";
export { GeminiSttService, GEMINI_SUPPORTED_AUDIO_TYPES } from "./stt/gemini-stt.service";
export { GroqTranslationService } from "./translation/groq-translation.service";
export { GroqDescriptionService } from "./description/groq-description.service";
export { MockSttService, DEFAULT_MOCK_SAMPLES } from "./stt/mock-stt.service";

export { GeminiTranslationService } from "./translation/gemini-translation.service";
export { MockTranslationService } from "./translation/mock-translation.service";

export { GeminiDescriptionService } from "./description/gemini-description.service";
