import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { Inquiry, InquiryStatus, InquiryProductSummary } from "../types";

const router = Router();

const INQUIRY_COLUMNS = "id, product_id, buyer_id, artisan_id, message, status, created_at";

interface InquiryRow {
  id: string;
  product_id: string;
  buyer_id: string;
  artisan_id: string;
  message: string;
  status: string;
  created_at: string;
}

function toInquiry(row: InquiryRow, product: InquiryProductSummary | null): Inquiry {
  return {
    inquiryId: row.id,
    productId: row.product_id,
    buyerId: row.buyer_id,
    artisanId: row.artisan_id,
    message: row.message,
    status: row.status as InquiryStatus,
    createdAt: row.created_at,
    product,
  };
}

async function attachProducts(rows: InquiryRow[]): Promise<Inquiry[]> {
  const productIds = [...new Set(rows.map((row) => row.product_id))];
  if (productIds.length === 0) return rows.map((row) => toInquiry(row, null));

  const { data, error } = await getSupabase()
    .from("products")
    .select("id, title_en, title_local, local_language, image_url, price")
    .in("id", productIds);

  if (error) throw new Error(`Could not load inquiry products: ${error.message}`);

  const byId = new Map(
    (data ?? []).map((product) => [
      product.id as string,
      {
        titleEn: product.title_en,
        titleLocal: product.title_local,
        localLanguage: product.local_language,
        imageUrl: product.image_url,
        price: Number(product.price),
      } satisfies InquiryProductSummary,
    ]),
  );

  return rows.map((row) => toInquiry(row, byId.get(row.product_id) ?? null));
}

const CreateInquirySchema = z.object({
  productId: z.string().uuid(),
  message: z.string().min(1).max(2000),
});

router.post(
  "/",
  requireAuth,
  requireRole("buyer"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateInquirySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supabase = getSupabase();
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id, user_id, status, flagged")
      .eq("id", parsed.data.productId)
      .maybeSingle();

    if (productError) throw new Error(`Could not look up the product: ${productError.message}`);
    if (!product || product.status !== "published" || product.flagged) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const { data, error } = await supabase
      .from("inquiries")
      .insert({
        product_id: product.id,
        buyer_id: req.uid,
        artisan_id: product.user_id,
        message: parsed.data.message,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Could not create the inquiry: ${error.message}`);

    res.status(201).json({ inquiryId: data.id });
  }),
);

router.get(
  "/mine",
  requireAuth,
  requireRole("buyer"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const { data, error } = await getSupabase()
      .from("inquiries")
      .select(INQUIRY_COLUMNS)
      .eq("buyer_id", req.uid)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not list inquiries: ${error.message}`);

    res.json(await attachProducts(data as InquiryRow[]));
  }),
);

router.get(
  "/received",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const { data, error } = await getSupabase()
      .from("inquiries")
      .select(INQUIRY_COLUMNS)
      .eq("artisan_id", req.uid)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not list inquiries: ${error.message}`);

    res.json(await attachProducts(data as InquiryRow[]));
  }),
);

const CloseInquirySchema = z.object({
  status: z.literal("closed"),
});

router.patch(
  "/:id",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = CloseInquirySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const { data, error } = await getSupabase()
      .from("inquiries")
      .update({ status: parsed.data.status })
      .eq("id", req.params.id as string)
      .or(`buyer_id.eq.${req.uid},artisan_id.eq.${req.uid}`)
      .select("id");

    if (error) throw new Error(`Could not update the inquiry: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }

    res.json({ success: true });
  }),
);

export default router;
