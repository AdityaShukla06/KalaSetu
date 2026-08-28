import { Router, Request, Response } from "express";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { verifyFirebaseToken } from "../middleware/auth";
import { z } from "zod";

const router = Router();
const db = getFirestore();

router.get(
  "/me",
  verifyFirebaseToken,
  async (req: Request, res: Response): Promise<void> => {
    const uid = req.uid;
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();

    if (!snap.exists) {
      const profile = {
        userId: uid,
        phoneNumber: "",
        displayName: null,
        shopName: null,
        language: "en",
        totalProducts: 0,
        createdAt: FieldValue.serverTimestamp(),
      };
      await ref.set(profile);
      res.status(201).json({ ...profile, createdAt: new Date().toISOString() });
      return;
    }

    res.json(snap.data());
  },
);

const UpdateUserSchema = z.object({
  displayName: z.string().max(80).optional(),
  shopName: z.string().max(120).optional(),
  phoneNumber: z.string().regex(/^\d{10}$/).optional(),
  language: z.enum(["en", "hi"]).optional(),
});

router.patch(
  "/me",
  verifyFirebaseToken,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    await db.collection("users").doc(req.uid).set(parsed.data, { merge: true });
    res.json({ success: true });
  },
);

export default router;
