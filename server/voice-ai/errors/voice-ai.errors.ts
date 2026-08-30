/**
 * Typed errors for the voice AI pipeline.
 *
 * Design goal (per project requirements): the backend should be able to log
 * exactly which AI stage failed, while the frontend only ever needs to show
 * one generic "could not understand your description" message. Routes map
 * `stage` to an HTTP status without leaking provider details to the client.
 */

export type VoiceAiStage = "stt" | "language-detection" | "translation" | "generation";

export class VoiceAiError extends Error {
  public readonly stage: VoiceAiStage;
  /** The original error, kept for server-side logs only, never serialize this to the client. */
  public readonly cause?: unknown;

  constructor(stage: VoiceAiStage, message: string, cause?: unknown) {
    super(message);
    this.name = "VoiceAiError";
    this.stage = stage;
    this.cause = cause;
  }
}

export class InvalidAudioError extends VoiceAiError {
  constructor(message = "Audio is missing, empty, or in an unsupported format", cause?: unknown) {
    super("stt", message, cause);
    this.name = "InvalidAudioError";
  }
}

export class EmptyTranscriptError extends VoiceAiError {
  constructor(message = "Speech-to-text produced an empty transcript", cause?: unknown) {
    super("stt", message, cause);
    this.name = "EmptyTranscriptError";
  }
}

export class LanguageDetectionError extends VoiceAiError {
  constructor(message = "Could not determine the spoken language", cause?: unknown) {
    super("language-detection", message, cause);
    this.name = "LanguageDetectionError";
  }
}

export class UnsupportedLanguageError extends VoiceAiError {
  constructor(detected: string, cause?: unknown) {
    super("language-detection", `Detected language "${detected}" is not currently supported`, cause);
    this.name = "UnsupportedLanguageError";
  }
}

export class TranslationFailedError extends VoiceAiError {
  constructor(message = "Translation failed", cause?: unknown) {
    super("translation", message, cause);
    this.name = "TranslationFailedError";
  }
}

export class DescriptionGenerationError extends VoiceAiError {
  constructor(message = "Description generation failed", cause?: unknown) {
    super("generation", message, cause);
    this.name = "DescriptionGenerationError";
  }
}

export class MalformedModelResponseError extends VoiceAiError {
  constructor(stage: VoiceAiStage, message = "Model returned a response in an unexpected shape", cause?: unknown) {
    super(stage, message, cause);
    this.name = "MalformedModelResponseError";
  }
}

/**
 * Maps any VoiceAiError to the single generic message the frontend already
 * knows how to render (see VoiceDescribeScreen.tsx's transcribe-error phase).
 * The backend developer should log `error` (with `.stage` and `.cause`)
 * server-side and send only this string (or an { error: "..." } body) to the client.
 */
export function toGenericClientMessage(_error: VoiceAiError): string {
  return "transcription_failed";
}
