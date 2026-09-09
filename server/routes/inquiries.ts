import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { sendInquiryMessageEmail } from "../lib/mailer";
import { loadEnv } from "../lib/env";
import { isAppLanguage } from "../../shared/languages";
import {
  Inquiry,
  InquiryMessage,
  InquirySenderRole,
  InquiryStatus,
  InquiryProductSummary,
  InquiryContactPreference,
} from "../types";

const router = Router();

const INQUIRY_COLUMNS =
  "id, product_id, buyer_id, artisan_id, quantity, contact_preference, contact_value, status, artisan_last_read_at, buyer_last_read_at, created_at";

interface InquiryRow {
  id: string;
  product_id: string;
  buyer_id: string;
  artisan_id: string;
  quantity: number | null;
  contact_preference: string | null;
  contact_value: string | null;
  status: string;
  artisan_last_read_at: string | null;
  buyer_last_read_at: string | null;
  created_at: string;
}

interface MessageRow {
  id: string;
  inquiry_id: string;
  sender_role: string;
  body: string;
  body_language: string | null;
  created_at: string;
}

function toMessage(row: MessageRow): InquiryMessage {
  return {
    messageId: row.id,
    senderRole: row.sender_role as InquirySenderRole,
    body: row.body,
    bodyLanguage: row.body_language,
    createdAt: row.created_at,
  };
}

const BodyLanguageSchema = z.string().refine(isAppLanguage, "Unsupported language").optional();

async function enrichInquiries(rows: InquiryRow[], viewerRole: "buyer" | "artisan"): Promise<Inquiry[]> {
  if (rows.length === 0) return [];

  const inquiryIds = rows.map((row) => row.id);
  const productIds = [...new Set(rows.map((row) => row.product_id))];
  const buyerIds = [...new Set(rows.map((row) => row.buyer_id))];
  const supabase = getSupabase();

  const [productsResult, buyersResult, messagesResult] = await Promise.all([
    supabase.from("products").select("id, title_en, title_local, local_language, image_url, price, passport_id").in("id", productIds),
    supabase.from("users").select("id, email").in("id", buyerIds),
    supabase
      .from("inquiry_messages")
      .select("id, inquiry_id, sender_role, body, body_language, created_at")
      .in("inquiry_id", inquiryIds)
      .order("created_at", { ascending: true }),
  ]);

  if (productsResult.error) throw new Error(`Could not load inquiry products: ${productsResult.error.message}`);
  if (buyersResult.error) throw new Error(`Could not load inquiry buyers: ${buyersResult.error.message}`);
  if (messagesResult.error) throw new Error(`Could not load inquiry messages: ${messagesResult.error.message}`);

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

  const messagesByInquiryId = new Map<string, MessageRow[]>();
  for (const row of (messagesResult.data ?? []) as MessageRow[]) {
    const list = messagesByInquiryId.get(row.inquiry_id) ?? [];
    list.push(row);
    messagesByInquiryId.set(row.inquiry_id, list);
  }

  const otherRole: InquirySenderRole = viewerRole === "buyer" ? "artisan" : "buyer";

  return rows.map((row) => {
    const messages = (messagesByInquiryId.get(row.id) ?? []).map(toMessage);
    const lastReadAt = viewerRole === "buyer" ? row.buyer_last_read_at : row.artisan_last_read_at;
    const lastFromOther = [...messages].reverse().find((message) => message.senderRole === otherRole);
    const isUnread = Boolean(
      lastFromOther && (!lastReadAt || new Date(lastFromOther.createdAt) > new Date(lastReadAt)),
    );

    return {
      inquiryId: row.id,
      productId: row.product_id,
      buyerId: row.buyer_id,
      buyerEmail: emailByBuyerId.get(row.buyer_id) ?? null,
      artisanId: row.artisan_id,
      quantity: row.quantity,
      contactPreference: (row.contact_preference as InquiryContactPreference) ?? "email",
      contactValue: row.contact_value,
      status: row.status as InquiryStatus,
      createdAt: row.created_at,
      product: productById.get(row.product_id) ?? null,
      messages,
      isUnread,
    };
  });
}

async function notifyNewMessage(params: {
  inquiryId: string;
  productId: string;
  senderRole: InquirySenderRole;
  senderId: string;
  recipientId: string;
  body: string;
  firstMessageContext?: {
    quantity: number | null;
    contactPreference: InquiryContactPreference;
    contactValue: string | null;
    buyerEmail: string;
  };
}): Promise<boolean> {
  const supabase = getSupabase();
  const [recipientResult, productResult, senderResult] = await Promise.all([
    supabase.from("users").select("email").eq("id", params.recipientId).maybeSingle(),
    supabase.from("products").select("title_en, image_url, passport_id").eq("id", params.productId).maybeSingle(),
    supabase.from("users").select("display_name, shop_name").eq("id", params.senderId).maybeSingle(),
  ]);

  if (!recipientResult.data?.email || !productResult.data) {
    console.warn("[inquiries] could not resolve a recipient email or the product, skipping notification", {
      inquiryId: params.inquiryId,
    });
    return false;
  }

  const senderName =
    params.senderRole === "artisan"
      ? senderResult.data?.shop_name ?? senderResult.data?.display_name ?? "The artisan"
      : senderResult.data?.display_name ?? "A buyer";

  const env = loadEnv();
  const inboxUrl =
    params.senderRole === "artisan" ? `${env.PUBLIC_APP_URL}/marketplace/profile` : `${env.PUBLIC_APP_URL}/inquiries`;

  const mailResult = await sendInquiryMessageEmail({
    recipientEmail: recipientResult.data.email,
    senderName,
    productTitle: productResult.data.title_en,
    productImageUrl: productResult.data.image_url,
    passportId: productResult.data.passport_id,
    messageBody: params.body,
    inboxUrl,
    firstMessageContext: params.firstMessageContext,
  });

  return mailResult.delivered;
}

const CreateInquirySchema = z
  .object({
    productId: z.string().uuid(),
    message: z.string().trim().min(1).max(2000),
    messageLanguage: BodyLanguageSchema,
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
      .select("id, user_id, status, flagged")
      .eq("id", parsed.data.productId)
      .maybeSingle();

    if (productError) throw new Error(`Could not look up the product: ${productError.message}`);
    if (!product || product.status !== "published" || product.flagged) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const { data: inquiry, error: insertError } = await supabase
      .from("inquiries")
      .insert({
        product_id: product.id,
        buyer_id: req.uid,
        artisan_id: product.user_id,
        quantity: parsed.data.quantity ?? null,
        contact_preference: parsed.data.contactPreference,
        contact_value: parsed.data.contactValue ?? null,
      })
      .select("id")
      .single();

    if (insertError) throw new Error(`Could not create the inquiry: ${insertError.message}`);

    const { error: messageError } = await supabase.from("inquiry_messages").insert({
      inquiry_id: inquiry.id,
      sender_role: "buyer",
      body: parsed.data.message,
      body_language: parsed.data.messageLanguage ?? null,
    });
    if (messageError) throw new Error(`Could not save the inquiry message: ${messageError.message}`);

    const emailDelivered = await notifyNewMessage({
      inquiryId: inquiry.id,
      productId: product.id,
      senderRole: "buyer",
      senderId: req.uid,
      recipientId: product.user_id,
      body: parsed.data.message,
      firstMessageContext: {
        quantity: parsed.data.quantity ?? null,
        contactPreference: parsed.data.contactPreference,
        contactValue: parsed.data.contactValue ?? null,
        buyerEmail: req.email,
      },
    });

    res.status(201).json({ inquiryId: inquiry.id, emailDelivered });
  }),
);

router.get(
  "/mine",
  requireAuth,
  requireRole("buyer"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("inquiries")
      .select(INQUIRY_COLUMNS)
      .eq("buyer_id", req.uid)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not list inquiries: ${error.message}`);

    const rows = data as InquiryRow[];
    const result = await enrichInquiries(rows, "buyer");

    const unreadIds = result.filter((inquiry) => inquiry.isUnread).map((inquiry) => inquiry.inquiryId);
    if (unreadIds.length > 0) {
      const { error: readError } = await supabase
        .from("inquiries")
        .update({ buyer_last_read_at: new Date().toISOString() })
        .in("id", unreadIds);
      if (readError) console.warn("[inquiries] could not mark inquiries as read", { message: readError.message });
    }

    res.json(result);
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
    const result = await enrichInquiries(rows, "artisan");

    const unreadIds = result.filter((inquiry) => inquiry.isUnread).map((inquiry) => inquiry.inquiryId);
    if (unreadIds.length > 0) {
      const { error: readError } = await supabase
        .from("inquiries")
        .update({ artisan_last_read_at: new Date().toISOString() })
        .in("id", unreadIds);
      if (readError) console.warn("[inquiries] could not mark inquiries as read", { message: readError.message });
    }

    res.json(result);
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

const SendMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  bodyLanguage: BodyLanguageSchema,
});

router.post(
  "/:id/messages",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supabase = getSupabase();
    const { data: inquiry, error } = await supabase
      .from("inquiries")
      .select("id, buyer_id, artisan_id, product_id")
      .eq("id", req.params.id as string)
      .maybeSingle();

    if (error) throw new Error(`Could not load the inquiry: ${error.message}`);

    let senderRole: InquirySenderRole | null = null;
    if (inquiry?.buyer_id === req.uid) senderRole = "buyer";
    else if (inquiry?.artisan_id === req.uid) senderRole = "artisan";

    if (!inquiry || !senderRole) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }

    const { data: message, error: insertError } = await supabase
      .from("inquiry_messages")
      .insert({
        inquiry_id: inquiry.id,
        sender_role: senderRole,
        body: parsed.data.body,
        body_language: parsed.data.bodyLanguage ?? null,
      })
      .select("id, created_at")
      .single();

    if (insertError) throw new Error(`Could not save the message: ${insertError.message}`);

    const recipientId = senderRole === "buyer" ? inquiry.artisan_id : inquiry.buyer_id;
    const emailDelivered = await notifyNewMessage({
      inquiryId: inquiry.id,
      productId: inquiry.product_id,
      senderRole,
      senderId: req.uid,
      recipientId,
      body: parsed.data.body,
    });

    res.status(201).json({ messageId: message.id, createdAt: message.created_at, emailDelivered });
  }),
);

export default router;
