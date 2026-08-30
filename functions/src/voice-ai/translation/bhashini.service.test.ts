import { describe, it, expect, vi, afterEach } from "vitest";
import { BhashiniTranslationService } from "./bhashini.service";
import { TranslationFailedError, MalformedModelResponseError } from "../errors/voice-ai.errors";

const credentials = { userId: "u", apiKey: "k", pipelineId: "p" };

const validPipelineConfig = {
  pipelineResponseConfig: [
    { taskType: "translation", config: [{ serviceId: "svc-1" }] },
  ],
  pipelineInferenceAPIEndPoint: {
    callbackUrl: "https://dhruva-api.bhashini.gov.in/services/inference/pipeline",
    inferenceApiKey: { name: "Authorization", value: "token-123" },
  },
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BhashiniTranslationService", () => {
  it("returns the text unchanged when source and target match", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = new BhashiniTranslationService(credentials);
    await expect(service.translate("namaste", "hi", "hi")).resolves.toBe("namaste");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the pipeline then returns the translated target text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(validPipelineConfig))
      .mockResolvedValueOnce(
        jsonResponse({
          pipelineResponse: [
            { taskType: "translation", output: [{ target: "एक मिट्टी का बर्तन" }] },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const service = new BhashiniTranslationService(credentials);
    const result = await service.translate("A clay pot", "en", "hi");

    expect(result).toBe("एक मिट्टी का बर्तन");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [configUrl, configInit] = fetchMock.mock.calls[0];
    expect(configUrl).toContain("/ulca/apis/v0/model/getModelsPipeline");
    expect(configInit.headers.userID).toBe("u");
    expect(configInit.headers.ulcaApiKey).toBe("k");

    const [computeUrl, computeInit] = fetchMock.mock.calls[1];
    expect(computeUrl).toBe(validPipelineConfig.pipelineInferenceAPIEndPoint.callbackUrl);
    expect(computeInit.headers.Authorization).toBe("token-123");
    expect(JSON.parse(computeInit.body).inputData.input[0].source).toBe("A clay pot");
    expect(JSON.parse(computeInit.body).pipelineTasks[0].config.serviceId).toBe("svc-1");
  });

  it("fails loudly when the pipeline config call is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 403)));

    const service = new BhashiniTranslationService(credentials);
    await expect(service.translate("A clay pot", "en", "hi")).rejects.toBeInstanceOf(
      TranslationFailedError,
    );
  });

  it("names the offending field when the config response shape is unexpected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })));

    const service = new BhashiniTranslationService(credentials);
    await expect(service.translate("A clay pot", "en", "hi")).rejects.toBeInstanceOf(
      MalformedModelResponseError,
    );
  });

  it("names the offending field when the compute response shape is unexpected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(validPipelineConfig))
        .mockResolvedValueOnce(jsonResponse({ nothing: "useful" })),
    );

    const service = new BhashiniTranslationService(credentials);
    await expect(service.translate("A clay pot", "en", "hi")).rejects.toBeInstanceOf(
      MalformedModelResponseError,
    );
  });

  it("treats an empty translation as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(validPipelineConfig))
        .mockResolvedValueOnce(
          jsonResponse({
            pipelineResponse: [{ taskType: "translation", output: [{ target: "   " }] }],
          }),
        ),
    );

    const service = new BhashiniTranslationService(credentials);
    await expect(service.translate("A clay pot", "en", "hi")).rejects.toBeInstanceOf(
      TranslationFailedError,
    );
  });
});
