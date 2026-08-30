import {
  SpeechToTextService,
  SpeechToTextResult,
  SUPPORTED_LANGUAGES,
} from "../types/voice-ai.types";
import {
  InvalidAudioError,
  EmptyTranscriptError,
  MalformedModelResponseError,
} from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";
import { normaliseAudioMimeType, extensionForAudio } from "./audio-mime";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export const GROQ_SUPPORTED_AUDIO_TYPES = [
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
];

const NAME_TO_CODE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const language of SUPPORTED_LANGUAGES) {
    map[language.englishName.toLowerCase()] = language.code;
    map[language.code] = language.code;
  }
  map.oriya = "or";
  map.meitei = "mni";
  map.manipuri = "mni";
  return map;
})();

/**
 * Maps what the speech model reports onto an app language code where we
 * recognise it, and otherwise returns the reported value unchanged. The
 * detected language is informational, so an unfamiliar one must not fail the
 * request: the artisan still gets their transcript translated.
 */
export function toSupportedLanguage(reported: string | undefined): string {
  const key = (reported ?? "").trim().toLowerCase();
  if (!key) return "unknown";
  return NAME_TO_CODE[key] ?? key;
}

export class GroqSttService implements SpeechToTextService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(env: Pick<VoiceAiEnv, "GROQ_API_KEY" | "GROQ_STT_MODEL">) {
    if (!env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.apiKey = env.GROQ_API_KEY;
    this.model = env.GROQ_STT_MODEL;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<SpeechToTextResult> {
    if (!audio || audio.length === 0) {
      throw new InvalidAudioError();
    }

    const audioMimeType = normaliseAudioMimeType(mimeType, GROQ_SUPPORTED_AUDIO_TYPES);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: audioMimeType }), `recording.${extensionForAudio(audioMimeType)}`);
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append(
      "prompt",
      "An Indian artisan describing a handmade product in their own language.",
    );

    let payload: { text?: string; language?: string };

    try {
      const response = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new InvalidAudioError(
          `Transcription provider returned ${response.status}`,
          detail.slice(0, 500),
        );
      }

      payload = (await response.json()) as { text?: string; language?: string };
    } catch (err) {
      if (err instanceof InvalidAudioError) throw err;
      throw new InvalidAudioError("Speech-to-text provider rejected or failed to process the audio", err);
    }

    const text = payload.text?.trim();
    if (!text) {
      throw new EmptyTranscriptError();
    }
    if (payload.language === undefined) {
      throw new MalformedModelResponseError("stt", "Transcription response had no language field");
    }

    return { text, language: toSupportedLanguage(payload.language) };
  }
}
