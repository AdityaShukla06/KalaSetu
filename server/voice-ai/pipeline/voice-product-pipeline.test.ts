import { describe, it, expect, vi } from "vitest";
import { processVoiceDescription } from "./voice-product-pipeline";
import { MockSttService } from "../stt/mock-stt.service";
import { MockTranslationService } from "../translation/mock-translation.service";
import { TranslationFailedError, DescriptionGenerationError } from "../errors/voice-ai.errors";
import {
  ProductDescriptionService,
  SpeechToTextService,
  VoiceAiDependencies,
} from "../types/voice-ai.types";

function stubDescriptionService(text = "A handwoven bamboo basket."): ProductDescriptionService {
  return { generateDescription: vi.fn().mockResolvedValue(text) };
}

function sttReturning(text: string, language: SpeechToTextResultLanguage): SpeechToTextService {
  return { transcribe: vi.fn().mockResolvedValue({ text, language }) };
}

type SpeechToTextResultLanguage = Awaited<
  ReturnType<SpeechToTextService["transcribe"]>
>["language"];

describe("processVoiceDescription", () => {
  it("translates a regional transcript to English before generating the description", async () => {
    const descriptionService = stubDescriptionService();
    const deps: VoiceAiDependencies = {
      sttService: sttReturning("यह बांस की टोकरी है।", "hi"),
      translationService: new MockTranslationService(),
      descriptionService,
    };

    const result = await processVoiceDescription(
      { audio: Buffer.from("some-audio-bytes"), mimeType: "audio/webm", category: "bamboo-cane", targetLanguage: "hi" },
      deps,
    );

    expect(descriptionService.generateDescription).toHaveBeenCalledWith(
      "[mock:hi->en] यह बांस की टोकरी है।",
      "bamboo-cane",
    );
    expect(result.transcript).toBe("यह बांस की टोकरी है।");
    expect(result.detectedLanguage).toBe("hi");
  });

  it("skips the inbound translation when the artisan already spoke English", async () => {
    const descriptionService = stubDescriptionService();
    const translationService = new MockTranslationService();
    const translateSpy = vi.spyOn(translationService, "translate");

    await processVoiceDescription(
      { audio: Buffer.from("some-audio-bytes"), mimeType: "audio/webm", category: "woodwork", targetLanguage: "hi" },
      { sttService: sttReturning("A carved wooden elephant.", "en"), translationService, descriptionService },
    );

    expect(descriptionService.generateDescription).toHaveBeenCalledWith(
      "A carved wooden elephant.",
      "woodwork",
    );
    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(translateSpy).toHaveBeenCalledWith("A handwoven bamboo basket.", "en", "hi");
  });

  it("derives the Hindi description from the generated English one", async () => {
    const result = await processVoiceDescription(
      { audio: Buffer.from("some-audio-bytes"), mimeType: "audio/webm", category: "pottery", targetLanguage: "hi" },
      {
        sttService: sttReturning("A clay pot.", "en"),
        translationService: new MockTranslationService(),
        descriptionService: stubDescriptionService("A hand-thrown clay pot."),
      },
    );

    expect(result.descriptionEn).toBe("A hand-thrown clay pot.");
    expect(result.descriptionLocal).toBe("[mock:en->hi] A hand-thrown clay pot.");
  });

  it("propagates a typed error with the failing stage", async () => {
    const deps: VoiceAiDependencies = {
      sttService: sttReturning("A clay pot.", "en"),
      translationService: new MockTranslationService({ source: "en", target: "hi" }),
      descriptionService: stubDescriptionService(),
    };

    await expect(
      processVoiceDescription(
        { audio: Buffer.from("some-audio-bytes"), mimeType: "audio/webm", category: "pottery", targetLanguage: "hi" },
        deps,
      ),
    ).rejects.toBeInstanceOf(TranslationFailedError);
  });

  it("wraps an unexpected error as a description generation failure", async () => {
    const deps: VoiceAiDependencies = {
      sttService: sttReturning("A clay pot.", "en"),
      translationService: new MockTranslationService(),
      descriptionService: { generateDescription: vi.fn().mockRejectedValue(new Error("boom")) },
    };

    await expect(
      processVoiceDescription(
        { audio: Buffer.from("some-audio-bytes"), mimeType: "audio/webm", category: "pottery", targetLanguage: "hi" },
        deps,
      ),
    ).rejects.toBeInstanceOf(DescriptionGenerationError);
  });

  it("rejects empty audio at the STT stage", async () => {
    const deps: VoiceAiDependencies = {
      sttService: new MockSttService(),
      translationService: new MockTranslationService(),
      descriptionService: stubDescriptionService(),
    };

    await expect(
      processVoiceDescription(
        { audio: Buffer.alloc(0), mimeType: "audio/webm", category: "pottery", targetLanguage: "hi" },
        deps,
      ),
    ).rejects.toMatchObject({ stage: "stt" });
  });
});
