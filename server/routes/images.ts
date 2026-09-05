import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { readRawBody, requestedContentType, PayloadTooLargeError } from "../middleware/rawBody";
import { getSupabase, getStorageBucket } from "../lib/supabase";
import { resolveOwnStorageUrl, InvalidStorageUrlError } from "../lib/ownStorageUrl";
import { enhanceProductImage, UnsupportedImageError } from "../services/imageEnhancer";
import { applyStudioAdjustments, StudioOptions } from "../services/imageStudio";

const router = Router();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function storeImage(buffer: Buffer, path: string, contentType: string): Promise<string> {
  const supabase = getSupabase();
  const bucket = getStorageBucket();

  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: false,
  });

  if (error) {
    throw new Error(`Could not store the image: ${error.message}`);
  }

  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

function handleImageError(err: unknown, res: Response): boolean {
  if (err instanceof PayloadTooLargeError) {
    res.status(413).json({ error: "image_too_large", message: err.message });
    return true;
  }
  if (err instanceof UnsupportedImageError) {
    res.status(400).json({ error: "unsupported_image", message: err.message });
    return true;
  }
  return false;
}

router.post(
  "/enhance",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = await readRawBody(req, MAX_IMAGE_BYTES);
      if (raw.length === 0) {
        res.status(400).json({ error: "No image data provided" });
        return;
      }

      const contentType = requestedContentType(req, "image/jpeg");
      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;

      const originalImageUrl = await storeImage(raw, `${req.uid}/original/${stamp}`, contentType);

      const processed = await enhanceProductImage(raw);
      const enhancedImageUrl = await storeImage(
        processed.buffer,
        `${req.uid}/enhanced/${stamp}.jpg`,
        processed.mimeType,
      );

      res.json({
        enhancedImageUrl,
        originalImageUrl,
        width: processed.width,
        height: processed.height,
      });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  }),
);

router.post(
  "/remove-background",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = await readRawBody(req, MAX_IMAGE_BYTES);
      if (raw.length === 0) {
        res.status(400).json({ error: "No image data provided" });
        return;
      }

      const processed = await enhanceProductImage(raw, { removeBackground: true });

      if (!processed.backgroundRemoved || !processed.cutoutBuffer) {
        res.json({ cutoutUrl: null, backgroundRemoved: false, notice: processed.notice });
        return;
      }

      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const cutoutUrl = await storeImage(processed.cutoutBuffer, `${req.uid}/cutout/${stamp}.png`, "image/png");

      res.json({ cutoutUrl, backgroundRemoved: true });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  }),
);

const StudioOptionsSchema = z.object({
  brightness: z.number().int().min(-2).max(2).optional(),
  contrast: z.number().int().min(-2).max(2).optional(),
  sharpen: z.boolean().optional(),
  autoLighting: z.boolean().optional(),
  backgroundBlur: z.boolean().optional(),
  backgroundFill: z.enum(["white", "neutral", "none"]).optional(),
  cropPreset: z.enum(["original", "square", "portrait"]).optional(),
});

const FinalizeSchema = z.object({
  sourceUrl: z.string().url(),
  options: StudioOptionsSchema,
});

router.post(
  "/finalize",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = FinalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    let sourceUrl: string;
    try {
      sourceUrl = resolveOwnStorageUrl(parsed.data.sourceUrl, getStorageBucket(), req.uid);
    } catch (err) {
      if (err instanceof InvalidStorageUrlError) {
        res.status(400).json({ error: "invalid_source_url" });
        return;
      }
      throw err;
    }

    const sourceRes = await fetch(sourceUrl);
    if (!sourceRes.ok) {
      res.status(404).json({ error: "source_not_found" });
      return;
    }
    const source = Buffer.from(await sourceRes.arrayBuffer());

    try {
      const result = await applyStudioAdjustments(source, parsed.data.options as StudioOptions);
      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const finalImageUrl = await storeImage(result.buffer, `${req.uid}/final/${stamp}.jpg`, result.mimeType);

      res.json({ finalImageUrl, width: result.width, height: result.height });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  }),
);

export default router;
