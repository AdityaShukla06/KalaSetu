import { SpeechToTextService, SpeechToTextResult, VoiceAiLogger } from "../types/voice-ai.types";

/**
 * Bhashini is the primary transcriber, but it is a shared government service
 * and it cannot detect the spoken language, so any failure or refusal falls
 * through to Whisper rather than reaching the artisan as an error.
 */
export class ChainSttService implements SpeechToTextService {
  private readonly primary: SpeechToTextService;
  private readonly fallback: SpeechToTextService;
  private readonly logger?: VoiceAiLogger;

  constructor(primary: SpeechToTextService, fallback: SpeechToTextService, logger?: VoiceAiLogger) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    sourceLanguage?: string,
  ): Promise<SpeechToTextResult> {
    try {
      const result = await this.primary.transcribe(audio, mimeType, sourceLanguage);
      this.logger?.info("voice-ai: bhashini transcribed", { sourceLanguage });
      return result;
    } catch (err) {
      this.logger?.warn("voice-ai: bhashini unavailable, falling back to groq", {
        sourceLanguage,
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
      return this.fallback.transcribe(audio, mimeType, sourceLanguage);
    }
  }
}
