const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqChatOptions {
  apiKey: string;
  model: string;
  prompt: string;
  json: boolean;
}

export async function groqChat(options: GroqChatOptions): Promise<string> {
  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.2,
      messages: [{ role: "user", content: options.prompt }],
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

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
