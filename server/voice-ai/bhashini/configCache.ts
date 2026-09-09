import { VoiceAiEnv } from "../config/env";
import { BhashiniUnavailableError } from "../errors/voice-ai.errors";
import { serviceIdFor } from "./serviceIds";

export interface BhashiniEndpoint {
  serviceId: string;
  computeUrl: string;
  authHeaderName: string;
  authHeaderValue: string;
}

type BhashiniEnv = Pick<
  VoiceAiEnv,
  | "BHASHINI_USER_ID"
  | "BHASHINI_UDYAT_KEY"
  | "BHASHINI_INFERENCE_API_KEY"
  | "BHASHINI_PIPELINE_ID"
  | "BHASHINI_CONFIG_URL"
  | "BHASHINI_COMPUTE_URL"
  | "BHASHINI_TIMEOUT_MS"
>;

interface ConfigResponse {
  pipelineResponseConfig?: Array<{
    taskType?: string;
    config?: Array<{ serviceId?: string; language?: { sourceLanguage?: string } }>;
  }>;
  pipelineInferenceAPIEndPoint?: {
    callbackUrl?: string;
    inferenceApiKey?: { name?: string; value?: string };
  };
}

/**
 * Resolved endpoints live only as long as a warm serverless instance, the same
 * bargain the Groq key cooldowns make in groq/keyPool.ts: the worst case on a
 * cold start is one extra config call, not a broken request.
 */
const cache = new Map<string, BhashiniEndpoint>();

export function resetBhashiniConfigCache(): void {
  cache.clear();
}

export function isBhashiniConfigured(env: {
  BHASHINI_USER_ID?: string;
  BHASHINI_UDYAT_KEY?: string;
  BHASHINI_INFERENCE_API_KEY?: string;
}): boolean {
  if (env.BHASHINI_INFERENCE_API_KEY) return true;
  return Boolean(env.BHASHINI_USER_ID && env.BHASHINI_UDYAT_KEY);
}

export async function resolveBhashiniEndpoint(
  env: BhashiniEnv,
  languageCode: string,
): Promise<BhashiniEndpoint> {
  const cached = cache.get(languageCode);
  if (cached) return cached;

  const knownServiceId = serviceIdFor(languageCode);
  if (knownServiceId && env.BHASHINI_INFERENCE_API_KEY) {
    const endpoint: BhashiniEndpoint = {
      serviceId: knownServiceId,
      computeUrl: env.BHASHINI_COMPUTE_URL,
      authHeaderName: "Authorization",
      authHeaderValue: env.BHASHINI_INFERENCE_API_KEY,
    };
    cache.set(languageCode, endpoint);
    return endpoint;
  }

  const endpoint = await fetchEndpointFromConfigCall(env, languageCode);
  cache.set(languageCode, endpoint);
  return endpoint;
}

async function fetchEndpointFromConfigCall(
  env: BhashiniEnv,
  languageCode: string,
): Promise<BhashiniEndpoint> {
  if (!env.BHASHINI_USER_ID || !env.BHASHINI_UDYAT_KEY) {
    throw new BhashiniUnavailableError(
      `No Bhashini service is configured for language "${languageCode}"`,
    );
  }

  let response: Response;
  try {
    response = await fetch(env.BHASHINI_CONFIG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        userID: env.BHASHINI_USER_ID,
        ulcaApiKey: env.BHASHINI_UDYAT_KEY,
      },
      body: JSON.stringify({
        pipelineTasks: [{ taskType: "asr", config: { language: { sourceLanguage: languageCode } } }],
        pipelineRequestConfig: { pipelineId: env.BHASHINI_PIPELINE_ID },
      }),
      signal: AbortSignal.timeout(env.BHASHINI_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BhashiniUnavailableError("Bhashini pipeline config call failed", err);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new BhashiniUnavailableError(
      `Bhashini pipeline config call returned ${response.status}`,
      detail.slice(0, 300),
    );
  }

  const payload = (await response.json()) as ConfigResponse;

  const asrTask = payload.pipelineResponseConfig?.find((task) => task.taskType === "asr");
  const serviceId = asrTask?.config?.find((entry) => entry.serviceId)?.serviceId;
  const inference = payload.pipelineInferenceAPIEndPoint;
  const computeUrl = inference?.callbackUrl ?? env.BHASHINI_COMPUTE_URL;
  const authHeaderName = inference?.inferenceApiKey?.name ?? "Authorization";
  const authHeaderValue = inference?.inferenceApiKey?.value ?? env.BHASHINI_INFERENCE_API_KEY;

  if (!serviceId || !authHeaderValue) {
    throw new BhashiniUnavailableError(
      `Bhashini pipeline config returned no usable ASR service for "${languageCode}"`,
    );
  }

  return { serviceId, computeUrl, authHeaderName, authHeaderValue };
}
