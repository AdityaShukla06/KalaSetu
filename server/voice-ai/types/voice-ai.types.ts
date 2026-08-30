/**
 * Core types for the KalaSetu voice-product-description AI module.
 *
 * This module is a standalone, framework-agnostic TypeScript service.
 * It has NO dependency on Express, and does not know about HTTP at all —
 * the backend developer is responsible for wiring `processVoiceDescription`
 * (see pipeline/voice-product-pipeline.ts) into a route.
 */

// ---------------------------------------------------------------------------
// Supported languages
// ---------------------------------------------------------------------------

/**
 * Languages this module is designed/tested against (per project requirements).
 * `code` is the short ISO-639-1-ish code used internally and sent to BHASHINI
 * (BHASHINI's ULCA APIs use these short codes, e.g. "hi", "en", "or" — see
 * translation/bhashini.service.ts for the verified source).
 *
 * `sttLanguageCode` is the BCP-47 code Gemini 3.5 Transcribe expects in
 * `transcription_config.language_codes` (verified against the official
 * "Audio transcription" Gemini API docs, languages table, Aug 2026).
 *
 * Adding a new Indian language later means adding one entry here — nothing
 * else in the pipeline hardcodes a language list.
 */
export const SUPPORTED_LANGUAGES = [
  { code: "hi", name: "Hindi", sttLanguageCode: "hi-IN" },
  { code: "bn", name: "Bengali", sttLanguageCode: "bn-IN" },
  { code: "or", name: "Odia", sttLanguageCode: "or-IN" },
  { code: "mr", name: "Marathi", sttLanguageCode: "mr-IN" },
  { code: "ta", name: "Tamil", sttLanguageCode: "ta-IN" },
  { code: "te", name: "Telugu", sttLanguageCode: "te-IN" },
  { code: "en", name: "English", sttLanguageCode: "en-IN" },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export function isSupportedLanguageCode(value: string): value is SupportedLanguageCode {
  return SUPPORTED_LANGUAGES.some((l) => l.code === value);
}

// ---------------------------------------------------------------------------
// Pipeline input / output (this is the contract the backend developer calls)
// ---------------------------------------------------------------------------

export interface VoiceDescriptionInput {
  /** Raw recorded audio bytes exactly as received from the multipart upload. */
  audio: Buffer;
  /** MIME type of the audio, e.g. "audio/webm" (the frontend's MediaRecorder output). */
  mimeType: string;
  /** Product category selected by the artisan, passed straight to Gemini. */
  category: string;
}

export interface VoiceDescriptionOutput {
  /** Original-language transcript, in its native script. */
  transcript: string;
  /** Final English product description. */
  descriptionEn: string;
  /** Hindi translation of descriptionEn (not independently generated). */
  descriptionHi: string;
  /** Language detected in the artisan's speech, for logging/analytics only. */
  detectedLanguage: SupportedLanguageCode;
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

export interface SpeechToTextResult {
  text: string;
  language: SupportedLanguageCode;
  /** 0-1 confidence if the provider exposes one; not all providers do. */
  confidence?: number;
}

export interface SpeechToTextService {
  transcribe(audio: Buffer, mimeType: string): Promise<SpeechToTextResult>;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export interface TranslationService {
  translate(
    text: string,
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Product description generation
// ---------------------------------------------------------------------------

export interface ProductDescriptionService {
  generateDescription(englishTranscript: string, category: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Dependency injection container for the pipeline
// ---------------------------------------------------------------------------

export interface VoiceAiDependencies {
  sttService: SpeechToTextService;
  translationService: TranslationService;
  descriptionService: ProductDescriptionService;
  /** Optional structured logger; defaults to a no-op. Never receives PII beyond the transcript. */
  logger?: VoiceAiLogger;
}

export interface VoiceAiLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
