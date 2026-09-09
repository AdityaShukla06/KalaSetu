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
  /** A known source language. Given, the text is translated from it verbatim. */
  from: z.string().refine(isAppLanguage, "Unsupported source language").optional(),
  /**
   * A guess at the source, used when `from` is absent. The sender's interface
   * language is a good guess but not proof: someone with an English interface
   * can still type romanised Hindi, so the model decides and reports back.
   */
  hint: z.string().refine(isAppLanguage, "Unsupported hint language").optional(),
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

    const { text, from, hint, to } = parsed.data;

    if (from === to) {
      res.json({ translation: text, from, to });
      return;
    }

    const { translationService } = getDeps();

    try {
      if (from) {
        const translation = await translationService.translate(text, from, to);
        res.json({ translation, from, to });
        return;
      }

      if (!translationService.detectAndTranslate) {
        res.status(400).json({ error: "source_language_required" });
        return;
      }

      const result = await translationService.detectAndTranslate(text, to, hint);
      res.json({
        translation: result.translation,
        from: result.detectedLanguage || null,
        to,
      });
    } catch (err: any) {
      console.error("translate failed", {
        from: from ?? "auto",
        to,
        message: err?.message,
        cause: err?.cause?.message ?? String(err?.cause ?? ""),
      });
      res.status(502).json({ error: "translation_failed" });
    }
  }),
);

export default router;
