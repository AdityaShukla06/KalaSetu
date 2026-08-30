import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { readRawBody, requestedContentType, PayloadTooLargeError } from "../middleware/rawBody";
import { processVoiceDescription, buildVoiceAiDependencies } from "../voice-ai";

const router = Router();
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

let voiceAiDeps: ReturnType<typeof buildVoiceAiDependencies> | undefined;

function getVoiceAiDeps() {
  if (!voiceAiDeps) {
    voiceAiDeps = buildVoiceAiDependencies({
      logger: {
        info: (message: string, meta?: Record<string, unknown>) => console.info("[voice-ai:info]", message, meta || ""),
        warn: (message: string, meta?: Record<string, unknown>) => console.warn("[voice-ai:warn]", message, meta || ""),
        error: (message: string, meta?: Record<string, unknown>) => console.error("[voice-ai:error]", message, meta || ""),
      },
    });
  }
  return voiceAiDeps;
}

router.post(
  "/transcribe",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const category = (req.query.category as string | undefined)?.trim();
    if (!category) {
      res.status(400).json({ error: "category query parameter is required" });
      return;
    }

    let audio: Buffer;
    try {
      audio = await readRawBody(req, MAX_AUDIO_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.status(413).json({ error: "audio_too_large", message: err.message });
        return;
      }
      throw err;
    }

    if (audio.length === 0) {
      res.status(400).json({ error: "No audio data provided" });
      return;
    }

    try {
      const result = await processVoiceDescription(
        {
          audio,
          mimeType: requestedContentType(req, "audio/wav"),
          category,
        },
        getVoiceAiDeps(),
      );

      res.json({
        transcript: result.transcript,
        descriptionEn: result.descriptionEn,
        descriptionHi: result.descriptionHi,
        detectedLanguage: result.detectedLanguage,
      });
    } catch (err: any) {
      console.error("voice/transcribe failed", { stage: err?.stage, message: err?.message });
      res.status(500).json({
        error: "transcription_failed",
        stage: err?.stage,
        message: err?.message || "Speech transcription or description generation failed",
      });
    }
  }),
);

export default router;
