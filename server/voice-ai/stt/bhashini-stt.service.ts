import { SpeechToTextService, SpeechToTextResult } from "../types/voice-ai.types";
import { BhashiniUnavailableError, EmptyTranscriptError } from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";
import { normaliseAudioMimeType } from "./audio-mime";
import { bhashiniSupportsLanguage, serviceIdFor } from "../bhashini/serviceIds";
import { resolveBhashiniEndpoint } from "../bhashini/configCache";

export const BHASHINI_SUPPORTED_AUDIO_TYPES = ["audio/wav", "audio/flac", "audio/mp3", "audio/mpeg"];

const AUDIO_FORMATS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
};

const SAMPLING_RATE = 16000;

interface ComputeResponse {
  pipelineResponse?: Array<{ taskType?: string; output?: Array<{ source?: string }> }>;
}

export class BhashiniSttService implements SpeechToTextService {
  private readonly env: VoiceAiEnv;

  constructor(env: VoiceAiEnv) {
    this.env = env;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    sourceLanguage?: string,
  ): Promise<SpeechToTextResult> {
    const language = (sourceLanguage ?? "").trim();

    if (!language || !bhashiniSupportsLanguage(language)) {
      throw new BhashiniUnavailableError(
        `Bhashini has no ASR service for language "${language || "unknown"}"`,
      );
    }

    if (!audio || audio.length === 0) {
      throw new BhashiniUnavailableError("Audio is missing or empty");
    }

    if (audio.length > this.env.BHASHINI_MAX_AUDIO_BYTES) {
      throw new BhashiniUnavailableError(
        `Audio is ${audio.length} bytes, over the ${this.env.BHASHINI_MAX_AUDIO_BYTES} byte Bhashini limit`,
      );
    }

    let audioFormat: string;
    try {
      audioFormat = AUDIO_FORMATS[normaliseAudioMimeType(mimeType, BHASHINI_SUPPORTED_AUDIO_TYPES)];
    } catch (err) {
      throw new BhashiniUnavailableError(`Bhashini does not accept "${mimeType}"`, err);
    }

    const endpoint = await resolveBhashiniEndpoint(this.env, language);
    const serviceId = serviceIdFor(language) ?? endpoint.serviceId;

    let response: Response;
    try {
      response = await fetch(endpoint.computeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [endpoint.authHeaderName]: endpoint.authHeaderValue,
        },
        body: JSON.stringify({
          pipelineTasks: [
            {
              taskType: "asr",
              config: {
                language: { sourceLanguage: language },
                serviceId,
                audioFormat,
                samplingRate: SAMPLING_RATE,
                preProcessors: ["vad"],
                postProcessors: ["itn"],
              },
            },
          ],
          inputData: {
            audio: [{ audioContent: audio.toString("base64") }],
          },
        }),
        signal: AbortSignal.timeout(this.env.BHASHINI_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new BhashiniUnavailableError(
          `Bhashini did not respond within ${this.env.BHASHINI_TIMEOUT_MS}ms`,
          err,
        );
      }
      throw new BhashiniUnavailableError("Bhashini compute call failed", err);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new BhashiniUnavailableError(
        `Bhashini compute call returned ${response.status}`,
        detail.slice(0, 300),
      );
    }

    const payload = (await response.json()) as ComputeResponse;
    const text = payload.pipelineResponse
      ?.find((task) => task.taskType === "asr")
      ?.output?.find((entry) => entry.source)
      ?.source?.trim();

    if (!text) {
      throw new EmptyTranscriptError("Bhashini returned an empty transcript");
    }

    return { text, language };
  }
}
