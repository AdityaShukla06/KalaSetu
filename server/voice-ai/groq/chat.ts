import { GroqKeyPool } from "./keyPool";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqChatOptions {
  keyPool: GroqKeyPool;
  model: string;
  fallbackModel?: string;
  prompt: string;
  imageDataUrl?: string;
  json: boolean;
}

export class GroqRateLimitError extends Error {
  readonly detail: string;

  constructor(model: string, detail: string) {
    super(`Groq rate limit reached for ${model}: ${detail}`);
    this.name = "GroqRateLimitError";
    this.detail = detail;
  }
}

type GroqContent = string | Array<Record<string, unknown>>;

function buildContent(options: GroqChatOptions): GroqContent {
  if (!options.imageDataUrl) return options.prompt;

  return [
    { type: "text", text: options.prompt },
    { type: "image_url", image_url: { url: options.imageDataUrl } },
  ];
}

async function callModel(options: GroqChatOptions, model: string, apiKey: string): Promise<string> {
  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: buildContent(options) }],
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (response.status === 429) {
    throw new GroqRateLimitError(model, (await response.text()).slice(0, 300));
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Groq returned ${response.status}: ${detail.slice(0, 400)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Groq returned an empty completion");
  }

  return content.trim();
}

/**
 * Groq's free tier caps tokens per day per model, so a busy day takes the
 * feature down entirely. Two separate allowances are worked through before
 * giving up: each model has its own quota, and each configured API key has its
 * own (as long as the keys belong to different Groq accounts, see keyPool.ts).
 * Only a rate limit rotates; a genuine error fails immediately rather than
 * replaying a broken request against every key in turn.
 */
export async function groqChat(options: GroqChatOptions): Promise<string> {
  const models = [options.model];
  if (options.fallbackModel && options.fallbackModel !== options.model) {
    models.push(options.fallbackModel);
  }

  const keys = options.keyPool.usableKeys();
  let lastRateLimit: GroqRateLimitError | undefined;

  for (const apiKey of keys) {
    for (const model of models) {
      try {
        return await callModel(options, model, apiKey);
      } catch (err) {
        if (!(err instanceof GroqRateLimitError)) throw err;
        lastRateLimit = err;
      }
    }

    if (lastRateLimit) options.keyPool.rest(apiKey, lastRateLimit.detail);
  }

  throw lastRateLimit ?? new Error("Groq had no usable API key configured");
}
