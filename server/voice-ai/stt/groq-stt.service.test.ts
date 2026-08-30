import { describe, it, expect, vi, afterEach } from "vitest";
import { GroqSttService, GROQ_SUPPORTED_AUDIO_TYPES, toSupportedLanguage } from "./groq-stt.service";
import { normaliseAudioMimeType } from "./audio-mime";
import { InvalidAudioError, EmptyTranscriptError } from "../errors/voice-ai.errors";

const env = { GROQ_API_KEY: "gsk_test", GROQ_STT_MODEL: "whisper-large-v3" };
const audio = Buffer.from("pretend this is audio");

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toSupportedLanguage", () => {
  it("maps the full language names whisper reports", () => {
    expect(toSupportedLanguage("english")).toBe("en");
    expect(toSupportedLanguage("hindi")).toBe("hi");
    expect(toSupportedLanguage("tamil")).toBe("ta");
    expect(toSupportedLanguage("telugu")).toBe("te");
  });

  it("accepts oriya as a name for odia", () => {
    expect(toSupportedLanguage("oriya")).toBe("or");
    expect(toSupportedLanguage("odia")).toBe("or");
  });

  it("accepts a bare code and ignores case and spacing", () => {
    expect(toSupportedLanguage("  HINDI ")).toBe("hi");
    expect(toSupportedLanguage("bn")).toBe("bn");
  });

  it("passes through a language it does not recognise rather than failing", () => {
    expect(toSupportedLanguage("french")).toBe("french");
    expect(toSupportedLanguage("bodo")).toBe("brx");
  });

  it("reports unknown when the model says nothing", () => {
    expect(toSupportedLanguage(undefined)).toBe("unknown");
    expect(toSupportedLanguage("  ")).toBe("unknown");
  });
});

describe("groq audio formats", () => {
  it("accepts what MediaRecorder produces, including webm", () => {
    expect(normaliseAudioMimeType("audio/webm;codecs=opus", GROQ_SUPPORTED_AUDIO_TYPES)).toBe("audio/webm");
    expect(normaliseAudioMimeType("audio/wav", GROQ_SUPPORTED_AUDIO_TYPES)).toBe("audio/wav");
    expect(normaliseAudioMimeType("audio/mp4", GROQ_SUPPORTED_AUDIO_TYPES)).toBe("audio/m4a");
  });

  it("still rejects something that is not audio", () => {
    expect(() => normaliseAudioMimeType("application/pdf", GROQ_SUPPORTED_AUDIO_TYPES)).toThrow(
      InvalidAudioError,
    );
  });
});

describe("GroqSttService", () => {
  it("requires an api key", () => {
    expect(() => new GroqSttService({ GROQ_API_KEY: undefined, GROQ_STT_MODEL: "m" })).toThrow(
      /GROQ_API_KEY/,
    );
  });

  it("rejects empty audio before calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GroqSttService(env).transcribe(Buffer.alloc(0), "audio/wav")).rejects.toBeInstanceOf(
      InvalidAudioError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the transcript and maps the reported language", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ text: "  यह एक मिट्टी का बर्तन है  ", language: "hindi" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GroqSttService(env).transcribe(audio, "audio/wav");

    expect(result).toEqual({ text: "यह एक मिट्टी का बर्तन है", language: "hi" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/audio/transcriptions");
    expect(init.headers.Authorization).toBe("Bearer gsk_test");
    expect(init.body.get("model")).toBe("whisper-large-v3");
    expect(init.body.get("response_format")).toBe("verbose_json");
  });

  it("treats an empty transcript as an error rather than an empty product", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ text: "   ", language: "english" })));

    await expect(new GroqSttService(env).transcribe(audio, "audio/wav")).rejects.toBeInstanceOf(
      EmptyTranscriptError,
    );
  });

  it("surfaces a provider failure with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" } as Response),
    );

    await expect(new GroqSttService(env).transcribe(audio, "audio/wav")).rejects.toThrow(/429/);
  });
});
