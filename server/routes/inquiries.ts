import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { sendInquiryEmail } from "../lib/mailer";
import { loadEnv } from "../lib/env";
import { Inquiry, InquiryStatus, InquiryProductSummary, InquiryContactPreference } from "../types";

const router = Router();

const INQUIRY_COLUMNS =
  "id, product_id, buyer_id, artisan_id, message, quantity, contact_preference, contact_value, status, read_at, responded_at, notified_at, created_at";

interface InquiryRow {
  id: string;
  product_id: string;
  buyer_id: string;
  artisan_id: string;
  message: string;
  quantity: number | null;
  contact_preference: string | null;
  contact_value: string | null;
  status: string;
  read_at: string | null;
  responded_at: string | null;
  notified_at: string | null;
  created_at: string;
}

function toInquiry(row: InquiryRow, product: InquiryProductSummary | null, buyerEmail: string | null): Inquiry {
  return {
    inquiryId: row.id,
    productId: row.product_id,
    buyerId: row.buyer_id,
    buyerEmail,
    artisanId: row.artisan_id,
    message: row.message,
    quantity: row.quantity,
    contactPreference: (row.contact_preference as InquiryContactPreference) ?? "email",
    contactValue: row.contact_value,
    status: row.status as InquiryStatus,
    readAt: row.read_at,
    respondedAt: row.responded_at,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
    product,
  };
}

async function enrichInquiries(rows: InquiryRow[]): Promise<Inquiry[]> {
  if (rows.length === 0) return [];

  const productIds = [...new Set(rows.map((row) => row.product_id))];
  const buyerIds = [...new Set(rows.map((row) => row.buyer_id))];
  const supabase = getSupabase();

  const [productsResult, buyersResult] = await Promise.all([
    supabase.from("products").select("id, title_en, title_local, local_language, image_url, price, passport_id").in("id", productIds),
    supabase.from("users").select("id, email").in("id", buyerIds),
  ]);

  if (productsResult.error) throw new Error(`Could not load inquiry products: ${productsResult.error.message}`);
  if (buyersResult.error) throw new Error(`Could not load inquiry buyers: ${buyersResult.error.message}`);

  const productById = new Map(
    (productsResult.data ?? []).map((product) => [
      product.id as string,
      {
        titleEn: product.title_en,
        titleLocal: product.title_local,
        localLanguage: product.local_language,
        imageUrl: product.image_url,
        price: Number(product.price),
        passportId: product.passport_id,
      } satisfies InquiryProductSummary,
    ]),
  );

  const emailByBuyerId = new Map((buyersResult.data ?? []).map((buyer) => [buyer.id as string, buyer.email as string]));

  return rows.map((row) =>
    toInquiry(row, productById.get(row.product_id) ?? null, emailByBuyerId.get(row.buyer_id) ?? null),
  );
}

const CreateInquirySchema = z
  .object({
    productId: z.string().uuid(),
    message: z.string().min(1).max(2000),
    quantity: z.number().int().positive().optional(),
    contactPreference: z.enum(["email", "phone", "whatsapp"]),
    contactValue: z.string().trim().min(1).max(40).optional(),
  })
  .refine((data) => data.contactPreference === "email" || Boolean(data.contactValue), {
    message: "Enter a phone number for this contact preference",
    path: ["contactValue"],
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
      .select("id, user_id, status, flagged, title_en, image_url, passport_id")
      .eq("id", parsed.data.productId)
      .maybeSingle();

    if (productError) throw new Error(`Could not look up the product: ${productError.message}`);
    if (!product || product.status !== "published" || product.flagged) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const { data: inserted, error } = await supabase
      .from("inquiries")
      .insert({
        product_id: product.id,
        buyer_id: req.uid,
        artisan_id: product.user_id,
        message: parsed.data.message,
        quantity: parsed.data.quantity ?? null,
        contact_preference: parsed.data.contactPreference,
        contact_value: parsed.data.contactValue ?? null,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Could not create the inquiry: ${error.message}`);

    const [artisanResult, buyerResult] = await Promise.all([
      supabase.from("users").select("email").eq("id", product.user_id).maybeSingle(),
      supabase.from("users").select("email").eq("id", req.uid).maybeSingle(),
    ]);

    let emailDelivered = false;
    if (artisanResult.data?.email && buyerResult.data?.email) {
      const env = loadEnv();
      const mailResult = await sendInquiryEmail({
        artisanEmail: artisanResult.data.email,
        productTitle: product.title_en,
        productImageUrl: product.image_url,
        passportId: product.passport_id,
        buyerMessage: parsed.data.message,
        quantity: parsed.data.quantity ?? null,
        contactPreference: parsed.data.contactPreference,
        contactValue: parsed.data.contactValue ?? null,
        buyerEmail: buyerResult.data.email,
        inboxUrl: `${env.PUBLIC_APP_URL}/inquiries`,
      });
      emailDelivered = mailResult.delivered;
      if (emailDelivered) {
        await supabase.from("inquiries").update({ notified_at: new Date().toISOString() }).eq("id", inserted.id);
      }
    } else {
      console.warn("[inquiries] could not resolve an email address for the artisan or buyer, skipping notification", {
        inquiryId: inserted.id,
      });
    }

    res.status(201).json({ inquiryId: inserted.id, emailDelivered });
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

    res.json(await enrichInquiries(data as InquiryRow[]));
  }),
);

router.get(
  "/received",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("inquiries")
      .select(INQUIRY_COLUMNS)
      .eq("artisan_id", req.uid)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not list inquiries: ${error.message}`);

    const rows = data as InquiryRow[];
    const unreadIds = rows.filter((row) => !row.read_at).map((row) => row.id);
    if (unreadIds.length > 0) {
      const { error: readError } = await supabase
        .from("inquiries")
        .update({ read_at: new Date().toISOString() })
        .in("id", unreadIds);
      if (readError) {
        console.warn("[inquiries] could not mark inquiries as read", { message: readError.message });
      }
    }

    res.json(await enrichInquiries(rows));
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

router.patch(
  "/:id/responded",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const { data, error } = await getSupabase()
      .from("inquiries")
      .update({ responded_at: new Date().toISOString() })
      .eq("id", req.params.id as string)
      .eq("artisan_id", req.uid)
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
