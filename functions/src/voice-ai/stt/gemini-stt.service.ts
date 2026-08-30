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
  UnsupportedLanguageError,
  MalformedModelResponseError,
} from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";

const MAX_INLINE_AUDIO_BYTES = 18 * 1024 * 1024;

const SUPPORTED_AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/m4a",
  "audio/opus",
];

const MIME_ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/m4a",
  "audio/mp4": "audio/m4a",
  "audio/vorbis": "audio/ogg",
};

export function normaliseAudioMimeType(mimeType: string): string {
  const bare = (mimeType || "").split(";")[0].trim().toLowerCase();
  const aliased = MIME_ALIASES[bare] ?? bare;

  if (SUPPORTED_AUDIO_MIME_TYPES.includes(aliased)) {
    return aliased;
  }

  throw new InvalidAudioError(
    `Audio format "${bare || "unknown"}" is not supported for transcription`,
  );
}

export class GeminiSttService implements SpeechToTextService {
  private readonly client: GoogleGenAI;
  private readonly transcribeModel: string;

  constructor(env: Pick<VoiceAiEnv, "GEMINI_API_KEY" | "GEMINI_TRANSCRIBE_MODEL">) {
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    this.transcribeModel = env.GEMINI_TRANSCRIBE_MODEL;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<SpeechToTextResult> {
    if (!audio || audio.length === 0) {
      throw new InvalidAudioError();
    }
    if (audio.length > MAX_INLINE_AUDIO_BYTES) {
      throw new InvalidAudioError("Audio recording is too large to transcribe in a single request");
    }

    const audioMimeType = normaliseAudioMimeType(mimeType);
    const supportedCodes = SUPPORTED_LANGUAGES.map((l) => l.code);
    let raw: string | undefined;

    try {
      const response = await this.client.models.generateContent({
        model: this.transcribeModel,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { data: audio.toString("base64"), mimeType: audioMimeType } },
              { text: buildTranscriptionPrompt(supportedCodes) },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              transcript: { type: "STRING" },
              languageCode: { type: "STRING", enum: supportedCodes as unknown as string[] },
            },
            required: ["transcript", "languageCode"],
          },
        },
      });

      raw = response.text;
    } catch (err) {
      throw new InvalidAudioError("Speech-to-text provider rejected or failed to process the audio", err);
    }

    if (!raw) {
      throw new MalformedModelResponseError("stt", "Transcription response had no text output");
    }

    let parsed: { transcript?: string; languageCode?: string };
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError("stt", "Transcription response was not valid JSON", parseErr);
    }

    const text = parsed.transcript?.trim();
    if (!text) {
      throw new EmptyTranscriptError();
    }

    if (!parsed.languageCode || !isSupportedLanguageCode(parsed.languageCode)) {
      throw new UnsupportedLanguageError(parsed.languageCode ?? "unknown");
    }

    return { text, language: parsed.languageCode };
  }
}

function buildTranscriptionPrompt(supportedCodes: readonly string[]): string {
  return `Transcribe the attached audio recording of an Indian artisan describing a product they made.

Rules:
1. Transcribe exactly what is spoken, in the native script of the language spoken. Do not translate.
2. Do not add, summarise, correct, or embellish anything the speaker did not say.
3. If the speaker mixes languages, transcribe each part in its own script.
4. Identify the dominant spoken language and report it as one of these codes: ${supportedCodes.join(", ")}.
5. If the audio contains no intelligible speech, return an empty string for the transcript.

Respond with a JSON object of the form {"transcript": "...", "languageCode": "..."}.`;
}
