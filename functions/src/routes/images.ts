import { Router, Request, Response } from "express";
import multer from "multer";
import { getStorage } from "firebase-admin/storage";
import { verifyFirebaseToken } from "../middleware/auth";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post(
  "/upload",
  verifyFirebaseToken,
  upload.single("image"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No image file provided" });
      return;
    }

    const ext = req.file.mimetype.split("/")[1] ?? "jpg";
    const path = `products/${req.uid}/raw/${Date.now()}.${ext}`;
    const bucket = getStorage().bucket();
    const file = bucket.file(path);

    await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
    await file.makePublic();

    const imageUrl = `https://storage.googleapis.com/${bucket.name}/${path}`;
    res.json({ imageUrl });
  },
);

router.post(
  "/enhance",
  verifyFirebaseToken,
  upload.single("image"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No image file provided" });
      return;
    }

    const enhancedBuffer = req.file.buffer;
    const ext = req.file.mimetype.split("/")[1] ?? "jpg";
    const path = `products/${req.uid}/enhanced/${Date.now()}.${ext}`;
    const bucket = getStorage().bucket();
    const file = bucket.file(path);

    await file.save(enhancedBuffer, { metadata: { contentType: req.file.mimetype } });
    await file.makePublic();

    const enhancedImageUrl = `https://storage.googleapis.com/${bucket.name}/${path}`;
    res.json({ enhancedImageUrl });
  },
);

export default router;
