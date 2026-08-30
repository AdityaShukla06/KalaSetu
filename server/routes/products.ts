import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { Product, ProductStatus } from "../types";

const router = Router();

const PRODUCT_COLUMNS =
  "id, user_id, category, title_en, title_local, description_en, description_local, local_language, image_url, price, material_cost, status, created_at, updated_at";

interface ProductRow {
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
  created_at: string;
  updated_at: string;
}

export function toProduct(row: ProductRow): Product {
  return {
    productId: row.id,
    userId: row.user_id,
    category: row.category,
    titleEn: row.title_en,
    titleLocal: row.title_local,
    descriptionEn: row.description_en,
    descriptionLocal: row.description_local,
    localLanguage: row.local_language,
    imageUrl: row.image_url,
    price: Number(row.price),
    materialCost: Number(row.material_cost),
    status: row.status as ProductStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ProductInputSchema = z.object({
  category: z.string().min(1),
  titleEn: z.string().min(1),
  titleLocal: z.string().min(1),
  descriptionEn: z.string().min(1),
  descriptionLocal: z.string().min(1),
  localLanguage: z.string().min(2).max(8),
  imageUrl: z.string().url(),
  price: z.number().positive(),
  materialCost: z.number().positive(),
});

function toRow(input: Partial<z.infer<typeof ProductInputSchema>>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.category !== undefined) row.category = input.category;
  if (input.titleEn !== undefined) row.title_en = input.titleEn;
  if (input.titleLocal !== undefined) row.title_local = input.titleLocal;
  if (input.descriptionEn !== undefined) row.description_en = input.descriptionEn;
  if (input.descriptionLocal !== undefined) row.description_local = input.descriptionLocal;
  if (input.localLanguage !== undefined) row.local_language = input.localLanguage;
  if (input.imageUrl !== undefined) row.image_url = input.imageUrl;
  if (input.price !== undefined) row.price = input.price;
  if (input.materialCost !== undefined) row.material_cost = input.materialCost;
  return row;
}

router.post(
  "/",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ProductInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("products")
      .insert({ ...toRow(parsed.data), user_id: req.uid, status: "published" })
      .select("id")
      .single();

    if (error) throw new Error(`Could not create the product: ${error.message}`);

    await supabase.rpc("increment_total_products", { target_user: req.uid, delta: 1 });

    res.status(201).json({ productId: data.id });
  }),
);

router.get(
  "/",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const requestedUserId = req.query.userId as string | undefined;
    if (requestedUserId && requestedUserId !== req.uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { data, error } = await getSupabase()
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("user_id", req.uid)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not list products: ${error.message}`);

    res.json((data as ProductRow[]).map(toProduct));
  }),
);

router.patch(
  "/:id",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ProductInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("products")
      .update({ ...toRow(parsed.data), updated_at: new Date().toISOString() })
      .eq("id", req.params.id as string)
      .eq("user_id", req.uid)
      .select("id");

    if (error) throw new Error(`Could not update the product: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({ success: true });
  }),
);

router.delete(
  "/:id",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("products")
      .delete()
      .eq("id", req.params.id as string)
      .eq("user_id", req.uid)
      .select("id");

    if (error) throw new Error(`Could not delete the product: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    await supabase.rpc("increment_total_products", { target_user: req.uid, delta: -1 });

    res.json({ success: true });
  }),
);

export default router;
