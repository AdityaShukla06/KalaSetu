import { BackgroundRemovalService } from "../types/background-removal.types";
import { BackgroundRemovalError } from "../errors/image-ai.errors";

export class SelfHostedBgRemovalService implements BackgroundRemovalService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async warmUp(): Promise<void> {
    await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async removeBackground(input: Buffer, mimeType: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(input)], { type: mimeType }), "photo");

      const response = await fetch(`${this.baseUrl}/remove-background`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new BackgroundRemovalError(
          "provider_error",
          `Self-hosted background removal returned ${response.status}`,
          detail.slice(0, 500),
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      if (err instanceof BackgroundRemovalError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new BackgroundRemovalError(
          "timeout",
          `Self-hosted background removal did not respond within ${this.timeoutMs}ms`,
          err,
        );
      }
      throw new BackgroundRemovalError("provider_error", "Self-hosted background removal request failed", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
