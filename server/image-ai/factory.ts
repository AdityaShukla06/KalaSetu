import { BackgroundRemovalService } from "./types/background-removal.types";
import { RemoveBgService } from "./providers/remove-bg.service";
import { SelfHostedBgRemovalService } from "./providers/self-hosted-bg-removal.service";
import { ChainedBackgroundRemovalService } from "./providers/chained-bg-removal.service";
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
  const requested = env.BACKGROUND_REMOVAL_PROVIDER.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const services: BackgroundRemovalService[] = [];

  for (const provider of requested) {
    if (provider === "remove-bg") {
      if (!env.REMOVE_BG_API_KEY) continue;
      services.push(new RemoveBgService(env.REMOVE_BG_API_KEY, env.BACKGROUND_REMOVAL_TIMEOUT_MS));
      continue;
    }

    if (provider === "self-hosted") {
      const service = getSelfHostedBgRemoval();
      if (service) services.push(service);
    }
  }

  if (services.length === 0) return new DisabledBackgroundRemovalService();
  if (services.length === 1) return services[0];
  return new ChainedBackgroundRemovalService(services);
}

export function resetBackgroundRemovalCache(): void {
  cachedSelfHosted = undefined;
}
