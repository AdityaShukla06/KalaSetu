import { collectGroqApiKeys, GroqKeyPool } from "../../voice-ai/groq/keyPool";
import { CraftClassifierService } from "../types/classification.types";
import { loadImageAiEnv } from "../config/env";
import { GeminiClassifierService } from "./gemini-classifier.service";
import { GroqClassifierService } from "./groq-classifier.service";
import { RenderClassifierService } from "./render-classifier.service";

const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

let cachedChain: CraftClassifierService[] | undefined;
let cachedRender: RenderClassifierService | null | undefined;

function buildRenderService(): RenderClassifierService | null {
  const env = loadImageAiEnv();
  if (!env.CRAFT_CLASSIFIER_PROVIDERS.split(",").some((entry) => entry.trim() === "render")) {
    return null;
  }
  return new RenderClassifierService(env.CRAFT_CLASSIFIER_URL, env.CRAFT_CLASSIFIER_RENDER_TIMEOUT_MS);
}

export function buildCraftClassifierChain(): CraftClassifierService[] {
  if (cachedChain) return cachedChain;

  const env = loadImageAiEnv();
  const requested = env.CRAFT_CLASSIFIER_PROVIDERS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const chain: CraftClassifierService[] = [];

  for (const provider of requested) {
    if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) continue;
      const flashModel = process.env.GEMINI_FLASH_MODEL?.trim();
      const model = env.GEMINI_VISION_MODEL || flashModel || DEFAULT_GEMINI_MODEL;
      chain.push(new GeminiClassifierService(apiKey, model, env.CRAFT_CLASSIFIER_TIMEOUT_MS));
      continue;
    }

    if (provider === "groq") {
      const keys = collectGroqApiKeys(process.env);
      if (keys.length === 0) continue;
      chain.push(
        new GroqClassifierService(
          new GroqKeyPool(keys),
          env.GROQ_VISION_MODEL,
          env.GROQ_VISION_FALLBACK_MODEL,
          env.CRAFT_CLASSIFIER_TIMEOUT_MS,
        ),
      );
      continue;
    }

    if (provider === "render") {
      const render = getRenderClassifier();
      if (render) chain.push(render);
    }
  }

  cachedChain = chain;
  return chain;
}

export function getRenderClassifier(): RenderClassifierService | null {
  if (cachedRender === undefined) cachedRender = buildRenderService();
  return cachedRender;
}

export function resetCraftClassifierCache(): void {
  cachedChain = undefined;
  cachedRender = undefined;
}
