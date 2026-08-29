import { Router, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { getStorage } from "firebase-admin/storage";
import { verifyFirebaseToken } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

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

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

router.post(
  "/upload",
  verifyFirebaseToken,
  upload.single("image"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No image file provided" });
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) {
      res.status(400).json({ error: "Unsupported image type" });
      return;
    }

    const path = `products/${req.uid}/raw/${Date.now()}.${extensionFor(req.file.mimetype)}`;
    const imageUrl = await saveImage(req.file.buffer, req.file.mimetype, path);
    res.json({ imageUrl });
  }),
);

router.post(
  "/enhance",
  verifyFirebaseToken,
  upload.single("image"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No image file provided" });
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) {
      res.status(400).json({ error: "Unsupported image type" });
      return;
    }

    const path = `products/${req.uid}/enhanced/${Date.now()}.${extensionFor(req.file.mimetype)}`;
    const enhancedImageUrl = await saveImage(req.file.buffer, req.file.mimetype, path);
    res.json({ enhancedImageUrl });
  }),
);

export default router;
