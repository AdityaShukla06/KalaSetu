import { APP_LANGUAGES, isAppLanguage } from "../../../shared/languages";

/**
 * Core types for the KalaSetu voice-product-description AI module.
 *
 * This module is a standalone, framework-agnostic TypeScript service.
 * It has no dependency on Express and does not know about HTTP at all.
 * Routes wire `processVoiceDescription` (see
 * pipeline/voice-product-pipeline.ts) into the API.
 */

// ---------------------------------------------------------------------------
// Supported languages
// ---------------------------------------------------------------------------

/**
 * Languages this module is designed against. `code` is the short code used
 * internally and reported as the detected language. `sttLanguageCode` is the
 * BCP-47 form, kept for providers that want a locale hint.
 *
 * Adding a language means adding one entry here, nothing else in the pipeline
 * hardcodes a language list.
 */
export const SUPPORTED_LANGUAGES = APP_LANGUAGES;

export type SupportedLanguageCode = string;

export function isSupportedLanguageCode(value: string): boolean {
  return isAppLanguage(value);
}

// ---------------------------------------------------------------------------
// Pipeline input / output (this is the contract the backend developer calls)
// ---------------------------------------------------------------------------

export interface VoiceDescriptionInput {
  /** Raw recorded audio bytes exactly as received from the multipart upload. */
  audio: Buffer;
  /** MIME type of the audio, e.g. "audio/webm" (the frontend's MediaRecorder output). */
  mimeType: string;
  /** Product category selected by the artisan. */
  category: string;
  /** The app language the artisan chose. The description is returned in this too. */
  targetLanguage: string;
}

export interface VoiceDescriptionOutput {
  /** Original-language transcript, in its native script. */
  transcript: string;
  /** Final English product description. */
  descriptionEn: string;
  /** descriptionEn translated into the artisan's chosen language. */
  descriptionLocal: string;
  /** The language descriptionLocal is written in. */
  localLanguage: string;
  /**
   * Whatever the speech model reported. Informational only: it never gates the
   * request, so an artisan can speak a language the model does not name.
   */
  detectedLanguage: string;
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

export interface SpeechToTextResult {
  text: string;
  language: string;
  /** 0-1 confidence if the provider exposes one; not all providers do. */
  confidence?: number;
}

export interface SpeechToTextService {
  transcribe(audio: Buffer, mimeType: string): Promise<SpeechToTextResult>;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export interface DetectedTranslation {
  translation: string;
  detectedLanguage: string;
}

export interface TranslationService {
  translate(text: string, sourceLanguage: string, targetLanguage: string): Promise<string>;
  /**
   * Translates without being told the source language, reporting back what it
   * decided the source was. Handles text romanised into Latin letters, where
   * the writer's stated language is a hint at best. Optional: a provider that
   * cannot do this simply omits it, and callers fall back to an explicit source.
   */
  detectAndTranslate?(
    text: string,
    targetLanguage: string,
    sourceHint?: string,
  ): Promise<DetectedTranslation>;
}

// ---------------------------------------------------------------------------
// Product description generation
// ---------------------------------------------------------------------------

export interface ProductDescriptionService {
  generateDescription(englishTranscript: string, category: string): Promise<string>;
  generateHeritageStory(input: HeritageStoryInput): Promise<string>;
}

/**
 * Structured fields feeding the Craft Heritage Passport's story. Every field
 * besides category and descriptionEn is optional because the artisan may
 * not have provided it; an absent field must be omitted from the story, not
 * guessed, which is why the prompt is told explicitly which fields exist.
 */
export interface HeritageStoryInput {
  category: string;
  descriptionEn: string;
  material?: string;
  technique?: string;
  timeTaken?: string;
  giTag?: string;
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
