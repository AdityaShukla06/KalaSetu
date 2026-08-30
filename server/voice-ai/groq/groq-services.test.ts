import { describe, it, expect, vi, afterEach } from "vitest";
import { GroqTranslationService } from "../translation/groq-translation.service";
import { GroqDescriptionService } from "../description/groq-description.service";
import {
  TranslationFailedError,
  DescriptionGenerationError,
  MalformedModelResponseError,
} from "../errors/voice-ai.errors";

const env = {
  GROQ_API_KEY: "gsk_test",
  GROQ_LLM_MODEL: "openai/gpt-oss-120b",
  GROQ_LLM_FALLBACK_MODEL: "openai/gpt-oss-20b",
};

function completion(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GroqTranslationService", () => {
  it("returns the text untouched when the languages match", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GroqTranslationService(env).translate("namaste", "hi", "hi")).resolves.toBe("namaste");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the translated field and asks for JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"translation":"एक मिट्टी का बर्तन"}'));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GroqTranslationService(env).translate("A clay pot", "en", "hi");
    expect(out).toBe("एक मिट्टी का बर्तन");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("fails loudly on a provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response),
    );

    await expect(new GroqTranslationService(env).translate("A clay pot", "en", "hi")).rejects.toBeInstanceOf(
      TranslationFailedError,
    );
  });

  it("rejects a response that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion("just some prose")));

    await expect(new GroqTranslationService(env).translate("A clay pot", "en", "hi")).rejects.toBeInstanceOf(
      MalformedModelResponseError,
    );
  });

  it("treats an empty translation as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion('{"translation":"   "}')));

    await expect(new GroqTranslationService(env).translate("A clay pot", "en", "hi")).rejects.toBeInstanceOf(
      TranslationFailedError,
    );
  });
});

describe("rate limit fallback", () => {
  it("retries on a second model when the primary is out of daily tokens", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, ok: false, text: async () => "tokens per day (TPD)" } as Response)
      .mockResolvedValueOnce(completion('{"descriptionEn":"A clay pot."}'));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GroqDescriptionService(env).generateDescription("a clay pot", "pottery");

    expect(out).toBe("A clay pot.");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("openai/gpt-oss-120b");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("openai/gpt-oss-20b");
  });

  it("gives up when the fallback is rate limited too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 429, ok: false, text: async () => "limited" } as Response),
    );

    await expect(
      new GroqDescriptionService(env).generateDescription("a clay pot", "pottery"),
    ).rejects.toBeInstanceOf(DescriptionGenerationError);
  });

  it("does not retry a non rate limit failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ status: 500, ok: false, text: async () => "boom" } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GroqDescriptionService(env).generateDescription("a clay pot", "pottery"),
    ).rejects.toBeInstanceOf(DescriptionGenerationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GroqDescriptionService", () => {
  it("refuses an empty transcript before calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GroqDescriptionService(env).generateDescription("  ", "pottery")).rejects.toBeInstanceOf(
      DescriptionGenerationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the generated description", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion('{"descriptionEn":"A hand thrown clay pot."}')));

    const out = await new GroqDescriptionService(env).generateDescription("a clay pot", "pottery");
    expect(out).toBe("A hand thrown clay pot.");
  });

  it("passes the category and transcript to the model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"descriptionEn":"x"}'));
    vi.stubGlobal("fetch", fetchMock);

    await new GroqDescriptionService(env).generateDescription("a blue clay pot", "pottery");

    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(prompt).toContain("a blue clay pot");
    expect(prompt).toContain("pottery");
    expect(prompt).toContain("Do NOT invent");
  });

  it("rejects a response missing the field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion('{"something":"else"}')));

    await expect(
      new GroqDescriptionService(env).generateDescription("a clay pot", "pottery"),
    ).rejects.toBeInstanceOf(MalformedModelResponseError);
  });
});
