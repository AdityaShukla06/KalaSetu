import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { AnalyticsDailyPoint, AnalyticsListingStat, AnalyticsSummary, ProductStatus } from "../types";

const router = Router();

const VIEWS_WINDOW_DAYS = 30;
const WEEK_DAYS = 7;
const MAX_VIEW_ROWS = 5000;
const MAX_INQUIRY_ROWS = 2000;

const RecordViewSchema = z.object({
  productId: z.string().uuid(),
});

router.post(
  "/view",
  requireAuth,
  requireRole("buyer"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = RecordViewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supabase = getSupabase();

    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id, status, flagged")
      .eq("id", parsed.data.productId)
      .maybeSingle();

    if (productError) throw new Error(`Could not look up the product: ${productError.message}`);
    if (!product || product.status !== "published" || product.flagged) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const { data: buyer, error: buyerError } = await supabase
      .from("users")
      .select("region")
      .eq("id", req.uid)
      .maybeSingle();

    if (buyerError) throw new Error(`Could not look up the buyer profile: ${buyerError.message}`);

    const { error } = await supabase.from("product_views").insert({
      product_id: product.id,
      viewer_role: "buyer",
      region: buyer?.region ?? null,
    });

    if (error) throw new Error(`Could not record the view: ${error.message}`);

    res.status(201).json({ success: true });
  }),
);

router.get(
  "/summary",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();

    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id, title_en, status, flagged")
      .eq("user_id", req.uid);

    if (productsError) throw new Error(`Could not load your products: ${productsError.message}`);

    const rows = products ?? [];
    const productIds = rows.map((row) => row.id as string);
    const activeListings = rows.filter((row) => row.status === "published" && !row.flagged).length;

    if (productIds.length === 0) {
      const empty: AnalyticsSummary = {
        totalViews: 0,
        viewsThisWeek: 0,
        totalInquiries: 0,
        activeListings: 0,
        viewsOverTime: buildEmptyDailySeries(),
        listings: [],
      };
      res.json(empty);
      return;
    }

    const weekAgo = new Date(Date.now() - WEEK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const windowAgo = new Date(Date.now() - VIEWS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const [totalViewsResult, viewsThisWeekResult, totalInquiriesResult, viewRowsResult, inquiryRowsResult] =
      await Promise.all([
        supabase
          .from("product_views")
          .select("id", { count: "exact", head: true })
          .in("product_id", productIds),
        supabase
          .from("product_views")
          .select("id", { count: "exact", head: true })
          .in("product_id", productIds)
          .gte("created_at", weekAgo),
        supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("artisan_id", req.uid),
        supabase
          .from("product_views")
          .select("product_id, created_at")
          .in("product_id", productIds)
          .gte("created_at", windowAgo)
          .order("created_at", { ascending: false })
          .limit(MAX_VIEW_ROWS),
        supabase
          .from("inquiries")
          .select("product_id, created_at")
          .eq("artisan_id", req.uid)
          .gte("created_at", windowAgo)
          .order("created_at", { ascending: false })
          .limit(MAX_INQUIRY_ROWS),
      ]);

    for (const result of [totalViewsResult, viewsThisWeekResult, totalInquiriesResult, viewRowsResult, inquiryRowsResult]) {
      if (result.error) throw new Error(`Could not load analytics: ${result.error.message}`);
    }

    const viewRows = (viewRowsResult.data ?? []) as Array<{ product_id: string; created_at: string }>;
    const inquiryRows = (inquiryRowsResult.data ?? []) as Array<{ product_id: string; created_at: string }>;

    const viewsOverTime = buildDailySeries(viewRows.map((row) => row.created_at));

    const viewCountByProduct = new Map<string, number>();
    for (const row of viewRows) {
      viewCountByProduct.set(row.product_id, (viewCountByProduct.get(row.product_id) ?? 0) + 1);
    }

    const inquiryCountByProduct = new Map<string, number>();
    for (const row of inquiryRows) {
      inquiryCountByProduct.set(row.product_id, (inquiryCountByProduct.get(row.product_id) ?? 0) + 1);
    }

    const listings: AnalyticsListingStat[] = rows
      .map((row) => ({
        productId: row.id as string,
        titleEn: row.title_en as string,
        status: row.status as ProductStatus,
        viewCount: viewCountByProduct.get(row.id as string) ?? 0,
        inquiryCount: inquiryCountByProduct.get(row.id as string) ?? 0,
      }))
      .sort((a, b) => b.viewCount - a.viewCount);

    const summary: AnalyticsSummary = {
      totalViews: totalViewsResult.count ?? 0,
      viewsThisWeek: viewsThisWeekResult.count ?? 0,
      totalInquiries: totalInquiriesResult.count ?? 0,
      activeListings,
      viewsOverTime,
      listings,
    };

    res.json(summary);
  }),
);

function buildEmptyDailySeries(): AnalyticsDailyPoint[] {
  return buildDailySeries([]);
}

function buildDailySeries(timestamps: string[]): AnalyticsDailyPoint[] {
  const byDay = new Map<string, number>();
  for (const timestamp of timestamps) {
    const day = timestamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  const series: AnalyticsDailyPoint[] = [];
  for (let i = VIEWS_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    series.push({ date, count: byDay.get(date) ?? 0 });
  }
  return series;
}

export default router;
