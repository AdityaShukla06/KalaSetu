import { BackgroundRemovalService } from "../types/background-removal.types";
import { BackgroundRemovalError } from "../errors/image-ai.errors";

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attemptRemoveBackground(input, mimeType);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          console.warn("[image-ai] self-hosted background removal attempt failed, retrying", {
            attempt,
            detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          });
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw lastError;
  }

  private async attemptRemoveBackground(input: Buffer, mimeType: string): Promise<Buffer> {
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
