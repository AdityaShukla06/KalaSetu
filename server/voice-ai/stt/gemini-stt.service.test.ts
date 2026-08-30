import { describe, it, expect } from "vitest";
import { normaliseAudioMimeType } from "./gemini-stt.service";
import { InvalidAudioError } from "../errors/voice-ai.errors";

describe("normaliseAudioMimeType", () => {
  it("strips codec parameters that providers reject", () => {
    expect(normaliseAudioMimeType("audio/ogg;codecs=opus")).toBe("audio/ogg");
    expect(normaliseAudioMimeType("audio/wav; codecs=1")).toBe("audio/wav");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(normaliseAudioMimeType("  AUDIO/WAV  ")).toBe("audio/wav");
  });

  it("maps common aliases onto a supported type", () => {
    expect(normaliseAudioMimeType("audio/x-wav")).toBe("audio/wav");
    expect(normaliseAudioMimeType("audio/mp4")).toBe("audio/m4a");
    expect(normaliseAudioMimeType("audio/x-m4a")).toBe("audio/m4a");
  });

  it("rejects webm, which MediaRecorder produces but the model does not accept", () => {
    expect(() => normaliseAudioMimeType("audio/webm;codecs=opus")).toThrow(InvalidAudioError);
  });

  it("rejects an empty or unknown type with a readable message", () => {
    expect(() => normaliseAudioMimeType("")).toThrow(/unknown/);
    expect(() => normaliseAudioMimeType("application/octet-stream")).toThrow(InvalidAudioError);
  });
});
