const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqChatOptions {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  prompt: string;
  json: boolean;
}

export class GroqRateLimitError extends Error {
  constructor(model: string, detail: string) {
    super(`Groq rate limit reached for ${model}: ${detail}`);
    this.name = "GroqRateLimitError";
  }
}

async function callModel(options: GroqChatOptions, model: string): Promise<string> {
  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: options.prompt }],
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
 * Groq's free tier caps tokens per day per model, so a busy day on one model
 * takes the feature down entirely. Each model has its own allowance, so a rate
 * limit falls through to a second model rather than failing the request.
 */
export async function groqChat(options: GroqChatOptions): Promise<string> {
  try {
    return await callModel(options, options.model);
  } catch (err) {
    const fallback = options.fallbackModel;
    if (!(err instanceof GroqRateLimitError) || !fallback || fallback === options.model) {
      throw err;
    }

    console.warn("[voice-ai] primary model rate limited, falling back", {
      from: options.model,
      to: fallback,
    });

    return await callModel(options, fallback);
  }
}
