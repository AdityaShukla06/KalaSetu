import { SpeechToTextService, SpeechToTextResult, SupportedLanguageCode } from "../types/voice-ai.types";
import { InvalidAudioError, EmptyTranscriptError } from "../errors/voice-ai.errors";

export interface MockSttSample {
  language: SupportedLanguageCode;
  text: string;
}

/** A few natural, unscripted-sounding artisan voice notes per target language. */
export const DEFAULT_MOCK_SAMPLES: MockSttSample[] = [
  { language: "hi", text: "यह बांस की टोकरी हाथ से बुनी गई है, घर में इस्तेमाल के लिए बनाई गई है।" },
  { language: "bn", text: "এটি হাতে বোনা সুতির শাড়ি, প্রাকৃতিক রঙে তৈরি।" },
  { language: "or", text: "ଏହା ହାତରେ ତିଆରି ପିତ୍ତଳ ପ୍ରଦୀପ, ପୂଜା ପାଇଁ ବ୍ୟବହାର ହୁଏ।" },
  { language: "mr", text: "ही हाताने विणलेली टोपली आहे, स्वयंपाकघरात भाज्या ठेवण्यासाठी वापरली जाते." },
  { language: "ta", text: "இது கையால் செய்யப்பட்ட மண் பானை, சமையலுக்கு பயன்படுத்தலாம்." },
  { language: "te", text: "ఇది చేతితో నేసిన వెదురు బుట్ట, ఇంట్లో వాడకానికి తయారు చేయబడింది." },
  { language: "en", text: "This is a hand-carved wooden elephant, made from a single block of sheesham wood." },
];

/**
 * Deterministic-enough mock: picks a sample based on a simple hash of the
 * audio buffer's length so the same recording returns the same result
 * across a test run, while different recordings still vary. Never makes
 * network calls, so it's safe for unit tests and CI.
 */
export class MockSttService implements SpeechToTextService {
  constructor(private readonly samples: MockSttSample[] = DEFAULT_MOCK_SAMPLES) {}

  async transcribe(audio: Buffer, _mimeType: string): Promise<SpeechToTextResult> {
    if (!audio || audio.length === 0) {
      throw new InvalidAudioError();
    }
    if (audio.length < 8) {
      // Simulates a provider rejecting audio too short to contain speech.
      throw new EmptyTranscriptError();
    }

    const index = audio.length % this.samples.length;
    const sample = this.samples[index];
    return { text: sample.text, language: sample.language, confidence: 0.9 };
  }
}
