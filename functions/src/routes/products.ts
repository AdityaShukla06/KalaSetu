import { Router, Request, Response } from "express";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { verifyFirebaseToken } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { z } from "zod";

const router = Router();
const db = getFirestore();

function serialiseProduct(data: FirebaseFirestore.DocumentData): FirebaseFirestore.DocumentData {
  const out: FirebaseFirestore.DocumentData = { ...data };
  for (const key of ["createdAt", "updatedAt"]) {
    const value = out[key];
    if (value && typeof value.toDate === "function") {
      out[key] = value.toDate().toISOString();
    }
  }
  return out;
}

const ProductInputSchema = z.object({
  category: z.string().min(1),
  titleEn: z.string().min(1),
  titleHi: z.string().min(1),
  descriptionEn: z.string().min(1),
  descriptionHi: z.string().min(1),
  imageUrl: z.string().url(),
  price: z.number().positive(),
  materialCost: z.number().positive(),
});

router.post(
  "/",
  verifyFirebaseToken,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ProductInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const uid = req.uid;
    const now = FieldValue.serverTimestamp();
    const ref = db.collection("products").doc();

    await ref.set({
      productId: ref.id,
      userId: uid,
      status: "published",
      ...parsed.data,
      createdAt: now,
      updatedAt: now,
    });

    await db.collection("users").doc(uid).set(
      { userId: uid, totalProducts: FieldValue.increment(1) },
      { merge: true },
    );

    res.status(201).json({ productId: ref.id });
  }),
);

router.get(
  "/",
  verifyFirebaseToken,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const uid = req.uid;
    const requestedUserId = req.query.userId as string | undefined;

    if (requestedUserId && requestedUserId !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const snap = await db
      .collection("products")
      .where("userId", "==", uid)
      .orderBy("createdAt", "desc")
      .get();

    res.json(snap.docs.map((doc) => serialiseProduct(doc.data())));
  }),
);

router.patch(
  "/:id",
  verifyFirebaseToken,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ProductInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const ref = db.collection("products").doc(req.params.id as string);
    const snap = await ref.get();

    if (!snap.exists) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (snap.data()?.userId !== req.uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    await ref.update({ ...parsed.data, updatedAt: FieldValue.serverTimestamp() });
    res.json({ success: true });
  }),
);

router.delete(
  "/:id",
  verifyFirebaseToken,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const ref = db.collection("products").doc(req.params.id as string);
    const snap = await ref.get();

    if (!snap.exists) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (snap.data()?.userId !== req.uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    await ref.delete();
    await db.collection("users").doc(req.uid).set(
      { userId: req.uid, totalProducts: FieldValue.increment(-1) },
      { merge: true },
    );

    res.json({ success: true });
  }),
);

export default router;
