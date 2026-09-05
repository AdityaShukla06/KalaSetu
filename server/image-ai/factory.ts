import { BackgroundRemovalService } from "./types/background-removal.types";
import { RemoveBgService } from "./providers/remove-bg.service";
import { DisabledBackgroundRemovalService } from "./providers/disabled.service";
import { loadImageAiEnv } from "./config/env";

export function buildBackgroundRemovalService(): BackgroundRemovalService {
  const env = loadImageAiEnv();

  if (env.BACKGROUND_REMOVAL_PROVIDER === "remove-bg" && env.REMOVE_BG_API_KEY) {
    return new RemoveBgService(env.REMOVE_BG_API_KEY, env.BACKGROUND_REMOVAL_TIMEOUT_MS);
  }

  return new DisabledBackgroundRemovalService();
}
