/**
 * Public entry point for the voice-ai module.
 *
 * Typical backend usage:
 *
 *   import { processVoiceDescription, buildVoiceAiDependencies } from "./voice-ai";
 *
 *   const deps = buildVoiceAiDependencies({ logger: myLogger });
 *
 *   app.post("/voice/transcribe", upload.single("audio"), async (req, res) => {
 *     try {
 *       const result = await processVoiceDescription(
 *         { audio: req.file.buffer, mimeType: req.file.mimetype, category: req.body.category },
 *         deps,
 *       );
 *       res.json(result);
 *     } catch (err) {
 *       // err is a VoiceAiError with `.stage` for server-side logging
 *       res.status(500).json({ error: "transcription_failed" });
 *     }
 *   });
 *
 * See voice_ai_integration.md for the full guide.
 */

export * from "./types/voice-ai.types";
export * from "./errors/voice-ai.errors";
export { loadEnv, hasBhashiniCredentials } from "./config/env";

export { processVoiceDescription } from "./pipeline/voice-product-pipeline";
export { buildVoiceAiDependencies } from "./pipeline/factory";

export { GeminiSttService } from "./stt/gemini-stt.service";
export { MockSttService, DEFAULT_MOCK_SAMPLES } from "./stt/mock-stt.service";

export { BhashiniTranslationService } from "./translation/bhashini.service";
export { GeminiTranslationService } from "./translation/gemini-translation.service";
export { MockTranslationService } from "./translation/mock-translation.service";

export { GeminiDescriptionService } from "./description/gemini-description.service";
