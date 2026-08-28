import { GoogleGenAI } from "@google/genai";
import {
  SpeechToTextService,
  SpeechToTextResult,
  SUPPORTED_LANGUAGES,
  isSupportedLanguageCode,
} from "../types/voice-ai.types";
import {
  InvalidAudioError,
  EmptyTranscriptError,
  LanguageDetectionError,
  UnsupportedLanguageError,
  MalformedModelResponseError,
} from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";

/**
 * Real STT provider, built on two verified, currently-documented Gemini API
 * capabilities (checked against ai.google.dev, Aug 2026):
 *
 * 1. `gemini-3.5-transcribe` — Google's dedicated speech-to-text model
 *    (now GA). Its official supported-languages table (ai.google.dev/
 *    gemini-api/docs/transcribe, checked 2026-08-28) explicitly lists
 *    hi-IN, bn-IN, bn-BD, or-IN (Odia), mr-IN, te-IN, and en-IN — i.e. six
 *    of our seven target languages — with the lowest published WER of
 *    Google's STT lineup (~2.6% non-streaming per Artificial Analysis).
 *
 *    !! VERIFIED GAP: Tamil (`ta-IN`) is NOT in that official table, despite
 *    Kannada/Malayalam/Telugu (other Dravidian languages) being present.
 *    The model's "85+ locales" claim may still cover it via general
 *    auto-detection, but this is unconfirmed — do not assume Tamil works
 *    until it's been validated with real Tamil audio samples (see
 *    evaluation/ACCURACY_EVALUATION.md). If it doesn't, Tamil needs a
 *    fallback provider (Whisper large-v3 or BHASHINI ASR) behind this same
 *    SpeechToTextService interface — no pipeline changes required.
 *
 * 2. A verified, DIFFERENT limitation: the Transcribe API's response schema
 *    (`interaction.output_text` + optional word/speaker/timestamp
 *    annotations) does NOT include a top-level "detected language" field.
 *    So language cannot be read off that response directly — this is not
 *    an oversight, it's what the documented response shape actually
 *    contains today.
 *
 * To get a reliable `language` field without inventing an undocumented API
 * field, this service makes a SECOND, small, text-only call to a Gemini
 * Flash model with a JSON response schema, asking it to classify the
 * transcript against our fixed supported-language list. This uses only the
 * well-documented `responseMimeType` / `responseSchema` structured-output
 * feature — nothing about it is speculative.
 *
 * This keeps the SpeechToTextService abstraction provider-agnostic: a future
 * swap to Whisper large-v3, faster-whisper, or BHASHINI ASR only requires a
 * new class implementing the same interface.
 */
export class GeminiSttService implements SpeechToTextService {
  private readonly client: GoogleGenAI;
  private readonly transcribeModel: string;
  private readonly flashModel: string;

  constructor(env: Pick<VoiceAiEnv, "GEMINI_API_KEY" | "GEMINI_TRANSCRIBE_MODEL" | "GEMINI_FLASH_MODEL">) {
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    this.transcribeModel = env.GEMINI_TRANSCRIBE_MODEL;
    this.flashModel = env.GEMINI_FLASH_MODEL;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<SpeechToTextResult> {
    if (!audio || audio.length === 0) {
      throw new InvalidAudioError();
    }

    const text = await this.runTranscription(audio, mimeType);

    if (!text || text.trim().length === 0) {
      throw new EmptyTranscriptError();
    }

    const language = await this.detectLanguage(text);

    return { text: text.trim(), language };
  }

  /**
   * Calls gemini-3.5-transcribe with automatic language detection
   * (`language_codes: []`, per the official docs) so the artisan is never
   * asked to pick a language. Uses the Files API for the upload, as
   * recommended for anything beyond a couple of seconds of audio.
   */
  private async runTranscription(audio: Buffer, mimeType: string): Promise<string> {
    try {
      const uploaded = await this.client.files.upload({
        file: new Blob([audio], { type: mimeType }),
        config: { mimeType },
      });

      const interaction = await this.client.interactions.create({
        model: this.transcribeModel,
        input: [
          {
            type: "audio",
            uri: uploaded.uri,
            mime_type: uploaded.mimeType ?? mimeType,
          },
        ],
        generation_config: {
          transcription_config: {
            // Empty list = automatic language detection + code-switching,
            // per the "Language detection and hints" section of the docs.
            language_codes: [],
            mode: "smart",
          },
        },
      } as Parameters<typeof this.client.interactions.create>[0]);

      const outputText = (interaction as { output_text?: string }).output_text;
      if (typeof outputText !== "string") {
        throw new MalformedModelResponseError("stt", "Transcribe response had no output_text field");
      }
      return outputText;
    } catch (err) {
      if (err instanceof MalformedModelResponseError) throw err;
      throw new InvalidAudioError("Speech-to-text provider rejected or failed to process the audio", err);
    }
  }

  /**
   * Classifies the transcript's language against our fixed supported list
   * using structured JSON output. This is a text-only, cheap Flash call —
   * it never re-listens to the audio.
   */
  private async detectLanguage(transcript: string): Promise<SpeechToTextResult["language"]> {
    const supportedCodes = SUPPORTED_LANGUAGES.map((l) => l.code);

    try {
      const response = await this.client.models.generateContent({
        model: this.flashModel,
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Identify which language this text is written in. " +
                  `Respond with exactly one of these codes: ${supportedCodes.join(", ")}. ` +
                  "If the text is a mix, pick the dominant language. " +
                  `Text:\n"""${transcript}"""`,
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              languageCode: { type: "STRING", enum: supportedCodes as unknown as string[] },
            },
            required: ["languageCode"],
          },
        },
      });

      const raw = response.text;
      if (!raw) throw new MalformedModelResponseError("language-detection");

      const parsed = JSON.parse(raw) as { languageCode?: string };
      if (!parsed.languageCode || !isSupportedLanguageCode(parsed.languageCode)) {
        throw new UnsupportedLanguageError(parsed.languageCode ?? "unknown");
      }
      return parsed.languageCode;
    } catch (err) {
      if (err instanceof UnsupportedLanguageError || err instanceof MalformedModelResponseError) throw err;
      throw new LanguageDetectionError("Language detection call failed", err);
    }
  }
}
