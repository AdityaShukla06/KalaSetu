import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAdminOr404 } from "../middleware/requireAdminOr404";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/auditLog";
import { sendDeactivationEmail, sendProductRemovedEmail } from "../lib/mailer";
import { signTicketToken } from "../lib/jwt";
import { loadEnv } from "../lib/env";
import { toProduct, PRODUCT_COLUMNS, ProductRow } from "./products";
import {
  ConsoleArtisan,
  ConsoleArtisanDetail,
  DashboardStats,
  DashboardSignupPoint,
  AuditLogEntry,
  FlaggedListing,
  FlaggedListingsResult,
  SupportTicket,
} from "../types";

const router = Router();

router.use(requireAdminOr404);

interface ArtisanRow {
  id: string;
  email: string;
  display_name: string | null;
  shop_name: string | null;
  region: string | null;
  is_active: boolean;
  total_products: number;
  created_at: string;
}

function toConsoleArtisan(row: ArtisanRow): ConsoleArtisan {
  return {
    userId: row.id,
    email: row.email,
    displayName: row.display_name,
    shopName: row.shop_name,
    region: row.region,
    isActive: row.is_active,
    totalProducts: row.total_products,
    createdAt: row.created_at,
  };
}

const SIGNUP_WINDOW_DAYS = 30;

router.get(
  "/dashboard",
  asyncRoute(async (_req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();

    const [artisans, buyers, products, pending, inquiries] = await Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "artisan"),
      supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "buyer"),
      supabase.from("products").select("id", { count: "exact", head: true }),
      supabase.from("products").select("id", { count: "exact", head: true }).eq("review_status", "pending"),
      supabase.from("inquiries").select("id", { count: "exact", head: true }),
    ]);

    for (const result of [artisans, buyers, products, pending, inquiries]) {
      if (result.error) throw new Error(`Could not load dashboard stats: ${result.error.message}`);
    }

    const since = new Date(Date.now() - SIGNUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: signups, error: signupError } = await supabase
      .from("users")
      .select("created_at")
      .gte("created_at", since);

    if (signupError) throw new Error(`Could not load signup history: ${signupError.message}`);

    const byDay = new Map<string, number>();
    for (const row of signups ?? []) {
      const day = (row.created_at as string).slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    const signupsOverTime: DashboardSignupPoint[] = [];
    for (let i = SIGNUP_WINDOW_DAYS - 1; i >= 0; i -= 1) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      signupsOverTime.push({ date, count: byDay.get(date) ?? 0 });
    }

    const stats: DashboardStats = {
      totalArtisans: artisans.count ?? 0,
      totalBuyers: buyers.count ?? 0,
      totalProducts: products.count ?? 0,
      pendingApproval: pending.count ?? 0,
      totalInquiries: inquiries.count ?? 0,
      signupsOverTime,
    };

    res.json(stats);
  }),
);

const MAX_ARTISAN_CANDIDATES = 1000;

router.get(
  "/artisans",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const q = (req.query.q as string | undefined)?.trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const { data, error } = await getSupabase()
      .from("users")
      .select("id, email, display_name, shop_name, region, is_active, total_products, created_at")
      .eq("role", "artisan")
      .order("created_at", { ascending: false })
      .limit(MAX_ARTISAN_CANDIDATES);

    if (error) throw new Error(`Could not list artisans: ${error.message}`);

    let rows = (data ?? []) as ArtisanRow[];
    if (q) {
      rows = rows.filter(
        (row) =>
          row.email.toLowerCase().includes(q) ||
          (row.display_name ?? "").toLowerCase().includes(q) ||
          (row.shop_name ?? "").toLowerCase().includes(q),
      );
    }

    const total = rows.length;
    const start = (page - 1) * limit;
    const page_ = rows.slice(start, start + limit);

    res.json({
      items: page_.map(toConsoleArtisan),
      page,
      limit,
      total,
      hasMore: start + page_.length < total,
    });
  }),
);

router.get(
  "/artisans/:id",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();
    const artisanId = req.params.id as string;

    const { data: artisan, error: artisanError } = await supabase
      .from("users")
      .select("id, email, display_name, shop_name, region, is_active, total_products, created_at")
      .eq("id", artisanId)
      .eq("role", "artisan")
      .maybeSingle();

    if (artisanError) throw new Error(`Could not load the artisan: ${artisanError.message}`);
    if (!artisan) {
      res.status(404).json({ error: "Artisan not found" });
      return;
    }

    const { data: listings, error: listingsError } = await supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("user_id", artisanId)
      .order("created_at", { ascending: false });

    if (listingsError) throw new Error(`Could not load the artisan's listings: ${listingsError.message}`);

    const result: ConsoleArtisanDetail = {
      ...toConsoleArtisan(artisan as ArtisanRow),
      listings: (listings as ProductRow[]).map(toProduct),
    };

    res.json(result);
  }),
);

const SetActiveSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().max(500).optional(),
});

router.patch(
  "/artisans/:id",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = SetActiveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supabase = getSupabase();
    const artisanId = req.params.id as string;

    const { data, error } = await supabase
      .from("users")
      .update({ is_active: parsed.data.isActive })
      .eq("id", artisanId)
      .eq("role", "artisan")
      .select("id, email")
      .maybeSingle();

    if (error) throw new Error(`Could not update the artisan: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: "Artisan not found" });
      return;
    }

    await recordAudit(req.uid, parsed.data.isActive ? "artisan.reactivate" : "artisan.deactivate", "users", artisanId, {
      reason: parsed.data.reason,
    });

    if (!parsed.data.isActive) {
      const reason = parsed.data.reason ?? "No reason was given.";
      const ticketToken = signTicketToken({ sub: artisanId, ticketType: "deactivation", context: reason });
      const ticketUrl = `${loadEnv().PUBLIC_APP_URL}/support/ticket?token=${ticketToken}`;
      await sendDeactivationEmail({ artisanEmail: data.email, reason, ticketUrl });
    }

    res.json({ success: true });
  }),
);

const MAX_MODERATION_CANDIDATES = 1000;

router.get(
  "/moderation/queue",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const q = (req.query.q as string | undefined)?.trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const { data, error } = await getSupabase()
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("review_status", "pending")
      .order("created_at", { ascending: true })
      .limit(MAX_MODERATION_CANDIDATES);

    if (error) throw new Error(`Could not load the moderation queue: ${error.message}`);

    let items = (data as ProductRow[]).map(toProduct);
    if (q) {
      items = items.filter(
        (item) =>
          item.titleEn.toLowerCase().includes(q) ||
          item.titleLocal.toLowerCase().includes(q) ||
          (item.artisanName ?? "").toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q),
      );
    }

    const total = items.length;
    const start = (page - 1) * limit;
    const page_ = items.slice(start, start + limit);

    res.json({ items: page_, page, limit, total, hasMore: start + page_.length < total });
  }),
);

async function loadProductOr404(id: string, res: Response): Promise<ProductRow | null> {
  const { data, error } = await getSupabase().from("products").select(PRODUCT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load the product: ${error.message}`);
  if (!data) {
    res.status(404).json({ error: "Product not found" });
    return null;
  }
  return data as ProductRow;
}

router.patch(
  "/moderation/:id/approve",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const productId = req.params.id as string;
    const product = await loadProductOr404(productId, res);
    if (!product) return;

    const { error } = await getSupabase()
      .from("products")
      .update({
        review_status: "approved",
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.uid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId);

    if (error) throw new Error(`Could not approve the product: ${error.message}`);

    await recordAudit(req.uid, "product.approve", "products", productId);

    res.json({ success: true });
  }),
);

const ReasonSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
});

router.patch(
  "/moderation/:id/reject",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const productId = req.params.id as string;
    const product = await loadProductOr404(productId, res);
    if (!product) return;

    const { error } = await getSupabase()
      .from("products")
      .update({
        review_status: "rejected",
        review_reason: parsed.data.reason,
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.uid,
        status: "draft",
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId);

    if (error) throw new Error(`Could not reject the product: ${error.message}`);

    await recordAudit(req.uid, "product.reject", "products", productId, { reason: parsed.data.reason });

    res.json({ success: true });
  }),
);

router.patch(
  "/moderation/:id/flag",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const productId = req.params.id as string;
    const product = await loadProductOr404(productId, res);
    if (!product) return;

    const { error } = await getSupabase()
      .from("products")
      .update({
        flagged: true,
        flag_reason: parsed.data.reason,
        review_status: "flagged",
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.uid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId);

    if (error) throw new Error(`Could not flag the product: ${error.message}`);

    await recordAudit(req.uid, "product.flag", "products", productId, { reason: parsed.data.reason });

    res.json({ success: true });
  }),
);

router.delete(
  "/products/:id",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const productId = req.params.id as string;
    const product = await loadProductOr404(productId, res);
    if (!product) return;

    const supabase = getSupabase();
    const { data: artisan } = await supabase.from("users").select("email").eq("id", product.user_id).maybeSingle();

    const { error } = await supabase.from("products").delete().eq("id", productId);
    if (error) throw new Error(`Could not delete the product: ${error.message}`);

    await supabase.rpc("increment_total_products", { target_user: product.user_id, delta: -1 });
    await recordAudit(req.uid, "product.delete", "products", productId, {
      reason: parsed.data.reason,
      metadata: { artisanId: product.user_id, titleEn: product.title_en },
    });

    if (artisan?.email) {
      const ticketToken = signTicketToken({
        sub: product.user_id,
        ticketType: "product_removal",
        context: `${product.title_en} | ${parsed.data.reason}`,
      });
      const ticketUrl = `${loadEnv().PUBLIC_APP_URL}/support/ticket?token=${ticketToken}`;
      await sendProductRemovedEmail({
        artisanEmail: artisan.email,
        productTitle: product.title_en,
        reason: parsed.data.reason,
        ticketUrl,
      });
    } else {
      console.warn("[moderation] could not resolve an email for the artisan, skipping product removal notification", {
        productId,
      });
    }

    res.json({ success: true });
  }),
);

router.get(
  "/flagged",
  asyncRoute(async (_req: Request, res: Response): Promise<void> => {
    const { data, error } = await getSupabase()
      .from("products")
      .select(PRODUCT_COLUMNS)
      .not("auto_flag_reason", "is", null)
      .order("created_at", { ascending: false });

    if (error) {
      if (error.code === "42703") {
        const unavailable: FlaggedListingsResult = { available: false, items: [] };
        res.json(unavailable);
        return;
      }
      throw new Error(`Could not load flagged listings: ${error.message}`);
    }

    const items: FlaggedListing[] = (data as ProductRow[]).map((row) => ({
      ...toProduct(row),
      autoFlagReason: row.auto_flag_reason as string,
    }));

    const result: FlaggedListingsResult = { available: true, items };
    res.json(result);
  }),
);

router.get(
  "/audit",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const { data, error } = await getSupabase()
      .from("audit_log")
      .select("id, actor_id, action, target_table, target_id, reason, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Could not load the audit log: ${error.message}`);

    const rows = data ?? [];
    const actorIds = [...new Set(rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))];

    let emailById = new Map<string, string>();
    if (actorIds.length > 0) {
      const { data: actors, error: actorsError } = await getSupabase()
        .from("users")
        .select("id, email")
        .in("id", actorIds);
      if (actorsError) throw new Error(`Could not load audit actors: ${actorsError.message}`);
      emailById = new Map((actors ?? []).map((actor) => [actor.id as string, actor.email as string]));
    }

    const entries: AuditLogEntry[] = rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorEmail: row.actor_id ? emailById.get(row.actor_id) ?? null : null,
      action: row.action,
      targetTable: row.target_table,
      targetId: row.target_id,
      reason: row.reason,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));

    res.json(entries);
  }),
);

interface TicketRow {
  id: string;
  artisan_id: string;
  ticket_type: "deactivation" | "product_removal";
  context: string | null;
  message: string;
  status: "open" | "resolved";
  admin_response: string | null;
  resolved_at: string | null;
  created_at: string;
}

router.get(
  "/tickets",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const status = req.query.status === "resolved" ? "resolved" : req.query.status === "all" ? undefined : "open";
    const supabase = getSupabase();

    let query = supabase
      .from("support_tickets")
      .select("id, artisan_id, ticket_type, context, message, status, admin_response, resolved_at, created_at")
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new Error(`Could not load tickets: ${error.message}`);

    const rows = data as TicketRow[];
    const artisanIds = [...new Set(rows.map((row) => row.artisan_id))];

    let artisanById = new Map<string, { email: string; display_name: string | null; is_active: boolean }>();
    if (artisanIds.length > 0) {
      const { data: artisans, error: artisansError } = await supabase
        .from("users")
        .select("id, email, display_name, is_active")
        .in("id", artisanIds);
      if (artisansError) throw new Error(`Could not load ticket artisans: ${artisansError.message}`);
      artisanById = new Map(
        (artisans ?? []).map((artisan) => [
          artisan.id as string,
          { email: artisan.email as string, display_name: artisan.display_name, is_active: artisan.is_active },
        ]),
      );
    }

    const tickets: SupportTicket[] = rows.map((row) => {
      const artisan = artisanById.get(row.artisan_id);
      return {
        ticketId: row.id,
        artisanId: row.artisan_id,
        artisanEmail: artisan?.email ?? "",
        artisanDisplayName: artisan?.display_name ?? null,
        ticketType: row.ticket_type,
        context: row.context,
        message: row.message,
        status: row.status,
        adminResponse: row.admin_response,
        artisanIsActive: artisan?.is_active ?? true,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      };
    });

    res.json(tickets);
  }),
);

const ResolveTicketSchema = z.object({
  response: z.string().trim().max(2000).optional(),
});

router.patch(
  "/tickets/:id/resolve",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ResolveTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const { data, error } = await getSupabase()
      .from("support_tickets")
      .update({
        status: "resolved",
        admin_response: parsed.data.response ?? null,
        resolved_at: new Date().toISOString(),
        resolved_by: req.uid,
      })
      .eq("id", req.params.id as string)
      .select("id")
      .maybeSingle();

    if (error) throw new Error(`Could not resolve the ticket: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    await recordAudit(req.uid, "ticket.resolve", "support_tickets", req.params.id as string);

    res.json({ success: true });
  }),
);

export default router;
