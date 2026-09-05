import { BackgroundRemovalService } from "../types/background-removal.types";
import { BackgroundRemovalError } from "../errors/image-ai.errors";

export class DisabledBackgroundRemovalService implements BackgroundRemovalService {
  async removeBackground(): Promise<Buffer> {
    throw new BackgroundRemovalError("not_configured", "Background removal is not configured");
  }
}
