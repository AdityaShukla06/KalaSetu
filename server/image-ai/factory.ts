import { BackgroundRemovalService } from "./types/background-removal.types";
import { SelfHostedBgRemovalService } from "./providers/self-hosted-bg-removal.service";
import { DisabledBackgroundRemovalService } from "./providers/disabled.service";
import { loadImageAiEnv } from "./config/env";

let cachedSelfHosted: SelfHostedBgRemovalService | null | undefined;

function buildSelfHostedService(): SelfHostedBgRemovalService | null {
  const env = loadImageAiEnv();
  if (!env.SELF_HOSTED_BG_REMOVAL_URL) return null;
  return new SelfHostedBgRemovalService(env.SELF_HOSTED_BG_REMOVAL_URL, env.SELF_HOSTED_BG_REMOVAL_TIMEOUT_MS);
}

export function getSelfHostedBgRemoval(): SelfHostedBgRemovalService | null {
  if (cachedSelfHosted === undefined) cachedSelfHosted = buildSelfHostedService();
  return cachedSelfHosted;
}

export function buildBackgroundRemovalService(): BackgroundRemovalService {
  const env = loadImageAiEnv();

  if (env.BACKGROUND_REMOVAL_PROVIDER === "self-hosted") {
    const service = getSelfHostedBgRemoval();
    if (service) return service;
  }

  return new DisabledBackgroundRemovalService();
}

export function resetBackgroundRemovalCache(): void {
  cachedSelfHosted = undefined;
}
