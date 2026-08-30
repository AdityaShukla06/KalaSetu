import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { buildVoiceAiDependencies } from "../voice-ai";
import { isAppLanguage } from "../../shared/languages";

const router = Router();

let deps: ReturnType<typeof buildVoiceAiDependencies> | undefined;

function getDeps() {
  if (!deps) {
    deps = buildVoiceAiDependencies({
      logger: {
        info: () => {},
        warn: (message: string, meta?: Record<string, unknown>) => console.warn("[translate]", message, meta || ""),
        error: (message: string, meta?: Record<string, unknown>) => console.error("[translate]", message, meta || ""),
      },
    });
  }
  return deps;
}

const TranslateSchema = z.object({
  text: z.string().min(1).max(4000),
  from: z.string().refine(isAppLanguage, "Unsupported source language"),
  to: z.string().refine(isAppLanguage, "Unsupported target language"),
});

router.post(
  "/",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = TranslateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const { text, from, to } = parsed.data;

    if (from === to) {
      res.json({ translation: text });
      return;
    }

    try {
      const translation = await getDeps().translationService.translate(text, from, to);
      res.json({ translation });
    } catch (err: any) {
      console.error("translate failed", {
        from,
        to,
        message: err?.message,
        cause: err?.cause?.message ?? String(err?.cause ?? ""),
      });
      res.status(502).json({ error: "translation_failed" });
    }
  }),
);

export default router;
