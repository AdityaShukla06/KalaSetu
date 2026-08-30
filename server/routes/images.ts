import { Router, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { readRawBody, PayloadTooLargeError } from "../middleware/rawBody";
import { getSupabase, getStorageBucket } from "../lib/supabase";
import { enhanceProductImage, UnsupportedImageError } from "../services/imageEnhancer";

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
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = await readRawBody(req, MAX_IMAGE_BYTES);
      if (raw.length === 0) {
        res.status(400).json({ error: "No image data provided" });
        return;
      }

      const processed = await enhanceProductImage(raw);
      const path = `${req.uid}/enhanced/${Date.now()}-${randomUUID().slice(0, 8)}.jpg`;
      const enhancedImageUrl = await storeImage(processed.buffer, path, processed.mimeType);

      res.json({ enhancedImageUrl, width: processed.width, height: processed.height });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  }),
);

export default router;
