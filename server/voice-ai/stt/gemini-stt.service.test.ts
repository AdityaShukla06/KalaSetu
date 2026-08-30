import { describe, it, expect } from "vitest";
import { normaliseAudioMimeType } from "./audio-mime";
import { GEMINI_SUPPORTED_AUDIO_TYPES } from "./gemini-stt.service";
import { InvalidAudioError } from "../errors/voice-ai.errors";

describe("normaliseAudioMimeType for gemini", () => {
  it("strips codec parameters that providers reject", () => {
    expect(normaliseAudioMimeType("audio/ogg;codecs=opus", GEMINI_SUPPORTED_AUDIO_TYPES)).toBe("audio/ogg");
    expect(normaliseAudioMimeType("audio/wav; codecs=1", GEMINI_SUPPORTED_AUDIO_TYPES)).toBe("audio/wav");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(normaliseAudioMimeType("  AUDIO/WAV  ", GEMINI_SUPPORTED_AUDIO_TYPES)).toBe("audio/wav");
  });

  it("maps common aliases onto a supported type", () => {
    expect(normaliseAudioMimeType("audio/x-wav", GEMINI_SUPPORTED_AUDIO_TYPES)).toBe("audio/wav");
    expect(normaliseAudioMimeType("audio/mp4", GEMINI_SUPPORTED_AUDIO_TYPES)).toBe("audio/m4a");
    expect(normaliseAudioMimeType("audio/x-m4a", GEMINI_SUPPORTED_AUDIO_TYPES)).toBe("audio/m4a");
  });

  it("rejects webm, which MediaRecorder produces but the model does not accept", () => {
    expect(() => normaliseAudioMimeType("audio/webm;codecs=opus", GEMINI_SUPPORTED_AUDIO_TYPES)).toThrow(InvalidAudioError);
  });

  it("rejects an empty or unknown type with a readable message", () => {
    expect(() => normaliseAudioMimeType("", GEMINI_SUPPORTED_AUDIO_TYPES)).toThrow(/unknown/);
    expect(() => normaliseAudioMimeType("application/octet-stream", GEMINI_SUPPORTED_AUDIO_TYPES)).toThrow(InvalidAudioError);
  });
});
