import { Router, Request, Response } from "express";
import multer from "multer";
import { verifyFirebaseToken } from "../middleware/auth";
import { processVoiceDescription, buildVoiceAiDependencies } from "../voice-ai";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const voiceAiDeps = buildVoiceAiDependencies({
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => console.info("[voice-ai:info]", message, meta || ""),
    warn: (message: string, meta?: Record<string, unknown>) => console.warn("[voice-ai:warn]", message, meta || ""),
    error: (message: string, meta?: Record<string, unknown>) => console.error("[voice-ai:error]", message, meta || ""),
  },
});

router.post(
  "/transcribe",
  verifyFirebaseToken,
  upload.single("audio"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    const category = req.body.category as string | undefined;
    if (!category) {
      res.status(400).json({ error: "category field is required" });
      return;
    }

    try {
      const result = await processVoiceDescription(
        {
          audio: req.file.buffer,
          mimeType: req.file.mimetype || "audio/webm",
          category,
        },
        voiceAiDeps,
      );

      res.json({
        transcript: result.transcript,
        descriptionEn: result.descriptionEn,
        descriptionHi: result.descriptionHi,
        detectedLanguage: result.detectedLanguage,
      });
    } catch (err: any) {
      console.error("voice/transcribe failed", {
        stage: err?.stage,
        message: err?.message,
      });
      res.status(500).json({
        error: "transcription_failed",
        stage: err?.stage,
        message: err?.message || "Speech transcription or description generation failed",
      });
    }
  },
);

export default router;
