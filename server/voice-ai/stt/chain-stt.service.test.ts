import { describe, it, expect, vi } from "vitest";
import { ChainSttService } from "./chain-stt.service";
import { BhashiniUnavailableError } from "../errors/voice-ai.errors";
import { SpeechToTextService } from "../types/voice-ai.types";

function stubStt(impl: SpeechToTextService["transcribe"]): SpeechToTextService {
  return { transcribe: vi.fn(impl) };
}

const audio = Buffer.from("audio");

describe("ChainSttService", () => {
  it("uses Bhashini and never touches Groq when Bhashini succeeds", async () => {
    const primary = stubStt(async () => ({ text: "नमस्ते", language: "hi" }));
    const fallback = stubStt(async () => ({ text: "unused", language: "hi" }));

    const result = await new ChainSttService(primary, fallback).transcribe(audio, "audio/wav", "hi");

    expect(result).toEqual({ text: "नमस्ते", language: "hi" });
    expect(primary.transcribe).toHaveBeenCalledWith(audio, "audio/wav", "hi");
    expect(fallback.transcribe).not.toHaveBeenCalled();
  });

  it("falls back to Groq when Bhashini refuses, passing the same arguments", async () => {
    const primary = stubStt(async () => {
      throw new BhashiniUnavailableError("no service for en");
    });
    const fallback = stubStt(async () => ({ text: "hello there", language: "en" }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await new ChainSttService(primary, fallback, logger).transcribe(audio, "audio/wav", "en");

    expect(result).toEqual({ text: "hello there", language: "en" });
    expect(fallback.transcribe).toHaveBeenCalledWith(audio, "audio/wav", "en");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("rethrows the Groq error when both fail, so the route still reports the stt stage", async () => {
    const primary = stubStt(async () => {
      throw new BhashiniUnavailableError("bhashini down");
    });
    const fallback = stubStt(async () => {
      throw new Error("groq down");
    });

    await expect(new ChainSttService(primary, fallback).transcribe(audio, "audio/wav", "hi")).rejects.toThrow(
      "groq down",
    );
  });
});
