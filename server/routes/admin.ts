import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { toProduct } from "./products";

const router = Router();

const PRODUCT_COLUMNS =
  "id, user_id, category, title_en, title_local, description_en, description_local, local_language, image_url, price, material_cost, status, flagged, flag_reason, created_at, updated_at";

interface AdminProductRow {
  id: string;
  user_id: string;
  category: string;
  title_en: string;
  title_local: string;
  description_en: string;
  description_local: string;
  local_language: string;
  image_url: string;
  price: number | string;
  material_cost: number | string;
  status: string;
  flagged: boolean;
  flag_reason: string | null;
  created_at: string;
  updated_at: string;
}

router.get(
  "/products",
  requireAuth,
  requireRole("admin"),
  asyncRoute(async (_req: Request, res: Response): Promise<void> => {
    const { data, error } = await getSupabase()
      .from("products")
      .select(PRODUCT_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not list products: ${error.message}`);

    res.json((data as AdminProductRow[]).map(toProduct));
  }),
);

const ModerateProductSchema = z.object({
  flagged: z.boolean().optional(),
  flagReason: z.string().max(500).nullable().optional(),
  status: z.enum(["draft", "published", "failed"]).optional(),
});

router.patch(
  "/products/:id/moderate",
  requireAuth,
  requireRole("admin"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ModerateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.flagged !== undefined) patch.flagged = parsed.data.flagged;
    if (parsed.data.flagReason !== undefined) patch.flag_reason = parsed.data.flagReason;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;

    if (Object.keys(patch).length === 0) {
      res.json({ success: true });
      return;
    }

    const { data, error } = await getSupabase()
      .from("products")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", req.params.id as string)
      .select("id");

    if (error) throw new Error(`Could not moderate the product: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({ success: true });
  }),
);

export default router;
