import { Router, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { getStorage } from "firebase-admin/storage";
import { verifyFirebaseToken } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import {
  enhanceProductImage,
  normaliseProductImage,
  UnsupportedImageError,
} from "../services/imageEnhancer";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

async function saveImage(buffer: Buffer, mimeType: string, path: string): Promise<string> {
  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  const downloadToken = randomUUID();

  await file.save(buffer, {
    metadata: {
      contentType: mimeType,
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });

  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(
    path,
  )}?alt=media&token=${downloadToken}`;
}

function rejectNonImage(req: Request, res: Response): boolean {
  if (!req.file) {
    res.status(400).json({ error: "No image file provided" });
    return true;
  }
  if (!req.file.mimetype.startsWith("image/")) {
    res.status(400).json({ error: "Uploaded file is not an image" });
    return true;
  }
  return false;
}

router.post(
  "/upload",
  verifyFirebaseToken,
  upload.single("image"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    if (rejectNonImage(req, res)) return;

    try {
      const processed = await normaliseProductImage(req.file!.buffer);
      const path = `products/${req.uid}/raw/${Date.now()}.jpg`;
      const imageUrl = await saveImage(processed.buffer, processed.mimeType, path);
      res.json({ imageUrl, width: processed.width, height: processed.height });
    } catch (err) {
      if (err instanceof UnsupportedImageError) {
        res.status(400).json({ error: "unsupported_image", message: err.message });
        return;
      }
      throw err;
    }
  }),
);

router.post(
  "/enhance",
  verifyFirebaseToken,
  upload.single("image"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    if (rejectNonImage(req, res)) return;

    try {
      const processed = await enhanceProductImage(req.file!.buffer);
      const path = `products/${req.uid}/enhanced/${Date.now()}.jpg`;
      const enhancedImageUrl = await saveImage(processed.buffer, processed.mimeType, path);
      res.json({ enhancedImageUrl, width: processed.width, height: processed.height });
    } catch (err) {
      if (err instanceof UnsupportedImageError) {
        res.status(400).json({ error: "unsupported_image", message: err.message });
        return;
      }
      throw err;
    }
  }),
);

export default router;
