import {
  VoiceAiDependencies,
  VoiceDescriptionInput,
  VoiceDescriptionOutput,
} from "../types/voice-ai.types";
import { VoiceAiError, DescriptionGenerationError } from "../errors/voice-ai.errors";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The single function the backend developer needs to call:
 *
 *   const result = await processVoiceDescription(
 *     { audio, mimeType, category },
 *     dependencies,
 *   );
 *
 * See pipeline/factory.ts for how to build `dependencies` from environment
 * variables.
 *
 * Pipeline:
 *   audio -> STT (+ automatic language detection)
 *         -> [regional -> English translation, skipped if already English]
 *         -> Gemini: English description generation
 *         -> English -> the artisan's chosen language (a translation of the
 *            FINAL English description, never generated independently)
 */
export async function processVoiceDescription(
  input: VoiceDescriptionInput,
  deps: VoiceAiDependencies,
): Promise<VoiceDescriptionOutput> {
  const logger = deps.logger ?? noopLogger;

  logger.info("voice-ai: starting pipeline", { category: input.category, audioBytes: input.audio?.length });

  try {
    const sttResult = await deps.sttService.transcribe(input.audio, input.mimeType);
    logger.info("voice-ai: stt complete", { detectedLanguage: sttResult.language });

    const transcript = sttResult.text;
    const detectedLanguage = sttResult.language;

    const englishTranscript =
      detectedLanguage === "en"
        ? transcript
        : await deps.translationService.translate(transcript, detectedLanguage, "en");

    if (detectedLanguage !== "en") {
      logger.info("voice-ai: regional -> English translation complete");
    }

    const descriptionEn = await deps.descriptionService.generateDescription(englishTranscript, input.category);
    logger.info("voice-ai: description generation complete");

    const localLanguage = input.targetLanguage || "en";
    const descriptionLocal =
      localLanguage === "en"
        ? descriptionEn
        : await deps.translationService.translate(descriptionEn, "en", localLanguage);

    if (localLanguage !== "en") {
      logger.info("voice-ai: English -> local translation complete", { localLanguage });
    }

    return { transcript, descriptionEn, descriptionLocal, localLanguage, detectedLanguage };
  } catch (err) {
    if (err instanceof VoiceAiError) {
      logger.error(`voice-ai: pipeline failed at stage "${err.stage}"`, { message: err.message });
      throw err;
    }
    logger.error("voice-ai: pipeline failed with an unexpected error", { err });
    throw new DescriptionGenerationError("Unexpected error in voice AI pipeline", err);
  }
}
