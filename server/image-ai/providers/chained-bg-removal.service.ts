import { BackgroundRemovalService } from "../types/background-removal.types";
import { BackgroundRemovalError } from "../errors/image-ai.errors";

export class ChainedBackgroundRemovalService implements BackgroundRemovalService {
  private readonly providers: readonly BackgroundRemovalService[];

  constructor(providers: readonly BackgroundRemovalService[]) {
    this.providers = providers;
  }

  async removeBackground(input: Buffer, mimeType: string): Promise<Buffer> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        return await provider.removeBackground(input, mimeType);
      } catch (err) {
        lastError = err;
        console.warn("[image-ai] background removal tier failed, trying the next one", {
          detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
      }
    }

    if (lastError instanceof BackgroundRemovalError) throw lastError;
    throw new BackgroundRemovalError("provider_error", "All background removal providers failed", lastError);
  }
}
