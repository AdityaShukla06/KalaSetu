import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { BhashiniSttService } from "./bhashini-stt.service";
import { resetBhashiniConfigCache } from "../bhashini/configCache";
import { BhashiniUnavailableError, EmptyTranscriptError } from "../errors/voice-ai.errors";
import { VoiceAiEnv } from "../config/env";

function env(overrides: Partial<VoiceAiEnv> = {}): VoiceAiEnv {
  return {
    VOICE_AI_PROVIDER: "groq",
    GROQ_STT_MODEL: "whisper-large-v3",
    GROQ_LLM_MODEL: "openai/gpt-oss-120b",
    GROQ_LLM_FALLBACK_MODEL: "openai/gpt-oss-20b",
    GEMINI_TRANSCRIBE_MODEL: "gemini-3.6-flash",
    GEMINI_FLASH_MODEL: "gemini-3.6-flash",
    BHASHINI_INFERENCE_API_KEY: "inference-key",
    BHASHINI_PIPELINE_ID: "64392f96daac500b55c543cd",
    BHASHINI_CONFIG_URL: "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline",
    BHASHINI_COMPUTE_URL: "https://dhruva-api.bhashini.gov.in/services/inference/pipeline",
    BHASHINI_TIMEOUT_MS: 20000,
    BHASHINI_MAX_AUDIO_BYTES: 6291456,
    ...overrides,
  } as VoiceAiEnv;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asrResponse(source: string): Response {
  return jsonResponse({ pipelineResponse: [{ taskType: "asr", output: [{ source }] }] });
}

const audio = Buffer.from("fake-wav-bytes");

beforeEach(() => {
  resetBhashiniConfigCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BhashiniSttService", () => {
  it("transcribes Hindi audio and reports the declared language back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(asrResponse("मेरा नाम महीर है"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new BhashiniSttService(env()).transcribe(audio, "audio/wav", "hi");

    expect(result).toEqual({ text: "मेरा नाम महीर है", language: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://dhruva-api.bhashini.gov.in/services/inference/pipeline");
    expect(init.headers.Authorization).toBe("inference-key");

    const body = JSON.parse(init.body);
    expect(body.pipelineTasks[0].config).toMatchObject({
      serviceId: "ai4bharat/conformer-hi-gpu--t4",
      audioFormat: "wav",
      samplingRate: 16000,
      language: { sourceLanguage: "hi" },
    });
    expect(body.inputData.audio[0].audioContent).toBe(audio.toString("base64"));
    expect(body.inputData.input).toBeUndefined();
  });

  it("picks the dravidian service for Tamil and the multilingual one for Santali", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => asrResponse("text"));
    vi.stubGlobal("fetch", fetchMock);

    const service = new BhashiniSttService(env());
    await service.transcribe(audio, "audio/wav", "ta");
    await service.transcribe(audio, "audio/wav", "sat");

    const serviceIds = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).pipelineTasks[0].config.serviceId);
    expect(serviceIds).toEqual([
      "ai4bharat/conformer-multilingual-dravidian-gpu--t4",
      "bhashini/ai4bharat/conformer-multilingual-asr",
    ]);
  });

  it("refuses English without calling Bhashini, so Whisper keeps its language detection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new BhashiniSttService(env()).transcribe(audio, "audio/wav", "en")).rejects.toThrow(
      BhashiniUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses audio the browser could not convert to wav", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new BhashiniSttService(env()).transcribe(audio, "audio/webm;codecs=opus", "hi"),
    ).rejects.toThrow(BhashiniUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses audio over the size limit before spending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const big = Buffer.alloc(101);
    await expect(
      new BhashiniSttService(env({ BHASHINI_MAX_AUDIO_BYTES: 100 })).transcribe(big, "audio/wav", "hi"),
    ).rejects.toThrow(/over the 100 byte Bhashini limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a provider error as unavailable so the chain can fall back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream exploded", { status: 503 })));

    await expect(new BhashiniSttService(env()).transcribe(audio, "audio/wav", "hi")).rejects.toThrow(
      /returned 503/,
    );
  });

  it("surfaces a timeout as unavailable", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    await expect(new BhashiniSttService(env()).transcribe(audio, "audio/wav", "hi")).rejects.toThrow(
      /did not respond within 20000ms/,
    );
  });

  it("treats an empty output array as an empty transcript", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ pipelineResponse: [{ taskType: "asr", output: [] }] })));

    await expect(new BhashiniSttService(env()).transcribe(audio, "audio/wav", "hi")).rejects.toThrow(
      EmptyTranscriptError,
    );
  });

  it("resolves the service through the config call once and reuses it", async () => {
    const configBody = {
      pipelineResponseConfig: [
        { taskType: "asr", config: [{ serviceId: "ai4bharat/conformer-hi-gpu--t4" }] },
      ],
      pipelineInferenceAPIEndPoint: {
        callbackUrl: "https://dhruva-api.bhashini.gov.in/services/inference/pipeline",
        inferenceApiKey: { name: "Authorization", value: "resolved-key" },
      },
    };

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(configBody))
      .mockImplementation(async () => asrResponse("transcript"));
    vi.stubGlobal("fetch", fetchMock);

    const service = new BhashiniSttService(
      env({ BHASHINI_INFERENCE_API_KEY: undefined, BHASHINI_USER_ID: "user", BHASHINI_UDYAT_KEY: "udyat" }),
    );

    await service.transcribe(audio, "audio/wav", "hi");
    await service.transcribe(audio, "audio/wav", "hi");

    const configCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("getModelsPipeline"));
    expect(configCalls).toHaveLength(1);
    expect(configCalls[0][1].headers).toMatchObject({ userID: "user", ulcaApiKey: "udyat" });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("resolved-key");
  });

  it("gives up cleanly when no credentials are configured at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new BhashiniSttService(env({ BHASHINI_INFERENCE_API_KEY: undefined })).transcribe(audio, "audio/wav", "hi"),
    ).rejects.toThrow(BhashiniUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
