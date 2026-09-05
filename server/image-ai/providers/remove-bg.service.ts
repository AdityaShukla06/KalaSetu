import { BackgroundRemovalService } from "../types/background-removal.types";
import { BackgroundRemovalError } from "../errors/image-ai.errors";

const REMOVE_BG_URL = "https://api.remove.bg/v1.0/removebg";

export class RemoveBgService implements BackgroundRemovalService {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async removeBackground(input: Buffer, mimeType: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const form = new FormData();
      form.append("image_file", new Blob([new Uint8Array(input)], { type: mimeType }), "photo");
      form.append("size", "auto");

      const response = await fetch(REMOVE_BG_URL, {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey },
        body: form,
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new BackgroundRemovalError("rate_limited", "remove.bg rate limit or quota reached");
      }
      if (!response.ok) {
        const detail = await response.text();
        throw new BackgroundRemovalError(
          "provider_error",
          `remove.bg returned ${response.status}`,
          detail.slice(0, 500),
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      if (err instanceof BackgroundRemovalError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new BackgroundRemovalError("timeout", `remove.bg did not respond within ${this.timeoutMs}ms`, err);
      }
      throw new BackgroundRemovalError("provider_error", "remove.bg request failed", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
