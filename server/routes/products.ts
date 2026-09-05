import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { Product, ProductStatus, ProductWithArtisan } from "../types";
import { buildVoiceAiDependencies } from "../voice-ai";
import { isAppLanguage } from "../../shared/languages";
import { DICTIONARIES } from "../../shared/locales";
import { isProductMaterial } from "../../shared/materials";
import { isIndianRegion } from "../../shared/regions";

const router = Router();

const MAX_RELOCALISE = 25;

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  textiles: "category.textiles",
  pottery: "category.pottery",
  jewelry: "category.jewelry",
  woodwork: "category.woodwork",
  "bamboo-cane": "category.bambooCane",
  other: "category.other",
};

/**
 * Titles are category names, so the interface dictionary already holds a
 * translation written in the right context. Asking a model to translate the
 * bare word instead turns "Pottery" into "limestone", which is what it did.
 */
function localisedTitle(category: string, language: string, fallback: string): string | null {
  const key = CATEGORY_LABEL_KEYS[category];
  if (!key) return null;
  return DICTIONARIES[language]?.[key] ?? DICTIONARIES.en?.[key] ?? fallback;
}

let voiceDeps: ReturnType<typeof buildVoiceAiDependencies> | undefined;

function getTranslator() {
  if (!voiceDeps) {
    voiceDeps = buildVoiceAiDependencies({
      logger: {
        info: () => {},
        warn: (m: string, meta?: Record<string, unknown>) => console.warn("[relocalise]", m, meta || ""),
        error: (m: string, meta?: Record<string, unknown>) => console.error("[relocalise]", m, meta || ""),
      },
    });
  }
  return voiceDeps.translationService;
}

export const PRODUCT_COLUMNS =
  "id, user_id, category, material, region, artisan_name, title_en, title_local, description_en, description_local, local_language, image_url, price, material_cost, status, flagged, flag_reason, review_status, reviewed_at, reviewed_by, review_reason, created_at, updated_at";

export interface ProductRow {
  id: string;
  user_id: string;
  category: string;
  material: string | null;
  region: string | null;
  artisan_name: string | null;
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
  review_status: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function toProduct(row: ProductRow): Product {
  return {
    productId: row.id,
    userId: row.user_id,
    category: row.category,
    material: row.material ?? undefined,
    region: row.region,
    artisanName: row.artisan_name,
    titleEn: row.title_en,
    titleLocal: row.title_local,
    descriptionEn: row.description_en,
    descriptionLocal: row.description_local,
    localLanguage: row.local_language,
    imageUrl: row.image_url,
    price: Number(row.price),
    materialCost: Number(row.material_cost),
    status: row.status as ProductStatus,
    flagged: row.flagged,
    flagReason: row.flag_reason,
    reviewStatus: row.review_status as Product["reviewStatus"],
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewReason: row.review_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ProductInputSchema = z.object({
  category: z.string().min(1),
  material: z.string().refine(isProductMaterial, "Unsupported material").optional(),
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
  if (input.material !== undefined) row.material = input.material;
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
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = ProductInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supabase = getSupabase();

    const { data: artisan, error: artisanError } = await supabase
      .from("users")
      .select("shop_name, display_name, region")
      .eq("id", req.uid)
      .maybeSingle();

    if (artisanError) throw new Error(`Could not look up the artisan profile: ${artisanError.message}`);

    const artisanName = artisan?.shop_name || artisan?.display_name || null;

    const { data, error } = await supabase
      .from("products")
      .insert({
        ...toRow(parsed.data),
        user_id: req.uid,
        status: "published",
        artisan_name: artisanName,
        region: artisan?.region ?? null,
      })
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

const MAX_MARKETPLACE_CANDIDATES = 1000;
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 48;

const MarketplaceQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().optional(),
  material: z.string().refine(isProductMaterial, "Unsupported material").optional(),
  region: z.string().refine(isIndianRegion, "Unsupported region").optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  sort: z.enum(["newest", "price_asc", "price_desc"]).default("newest"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export function matchesSearch(row: ProductRow, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    row.title_en.toLowerCase().includes(needle) ||
    row.title_local.toLowerCase().includes(needle) ||
    row.description_en.toLowerCase().includes(needle) ||
    row.description_local.toLowerCase().includes(needle)
  );
}

router.get(
  "/marketplace",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = MarketplaceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const query = parsed.data;

    let dbQuery = getSupabase()
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("status", "published")
      .eq("flagged", false);

    if (query.category) dbQuery = dbQuery.eq("category", query.category);
    if (query.material) dbQuery = dbQuery.eq("material", query.material);
    if (query.region) dbQuery = dbQuery.eq("region", query.region);
    if (query.minPrice !== undefined) dbQuery = dbQuery.gte("price", query.minPrice);
    if (query.maxPrice !== undefined) dbQuery = dbQuery.lte("price", query.maxPrice);

    const { data, error } = await dbQuery
      .order("created_at", { ascending: false })
      .limit(MAX_MARKETPLACE_CANDIDATES);

    if (error) throw new Error(`Could not list marketplace products: ${error.message}`);

    let rows = data as ProductRow[];
    if (query.q) rows = rows.filter((row) => matchesSearch(row, query.q as string));

    if (query.sort === "price_asc") {
      rows = [...rows].sort((a, b) => Number(a.price) - Number(b.price));
    } else if (query.sort === "price_desc") {
      rows = [...rows].sort((a, b) => Number(b.price) - Number(a.price));
    }

    const total = rows.length;
    const start = (query.page - 1) * query.limit;
    const page = rows.slice(start, start + query.limit);

    res.json({
      items: page.map(toProduct),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: start + page.length < total,
    });
  }),
);

router.get(
  "/marketplace/:id",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();

    const { data: product, error: productError } = await supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("id", req.params.id as string)
      .eq("status", "published")
      .eq("flagged", false)
      .maybeSingle();

    if (productError) throw new Error(`Could not load the product: ${productError.message}`);
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const { data: artisan, error: artisanError } = await supabase
      .from("users")
      .select("id, shop_name, display_name, region, total_products")
      .eq("id", (product as ProductRow).user_id)
      .maybeSingle();

    if (artisanError) throw new Error(`Could not load the artisan profile: ${artisanError.message}`);

    const result: ProductWithArtisan = {
      ...toProduct(product as ProductRow),
      artisan: {
        userId: artisan?.id ?? (product as ProductRow).user_id,
        shopName: artisan?.shop_name ?? null,
        displayName: artisan?.display_name ?? null,
        region: artisan?.region ?? null,
        totalProducts: artisan?.total_products ?? 0,
      },
    };

    res.json(result);
  }),
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("artisan"),
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
  requireRole("artisan"),
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

const RelocaliseSchema = z.object({
  language: z.string().refine(isAppLanguage, "Unsupported language"),
});

/**
 * Re-derives every listing's local text from its English text after the artisan
 * changes language. English is the canonical copy, so a listing can always be
 * regenerated rather than left stranded in a language its owner no longer reads.
 */
router.post(
  "/relocalise",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = RelocaliseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const language = parsed.data.language;
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("products")
      .select("id, category, title_en, description_en, local_language")
      .eq("user_id", req.uid)
      .neq("local_language", language)
      .order("created_at", { ascending: false })
      .limit(MAX_RELOCALISE);

    if (error) throw new Error(`Could not list products to relocalise: ${error.message}`);

    const rows = data ?? [];
    if (rows.length === 0) {
      res.json({ updated: 0, failed: 0, remaining: 0 });
      return;
    }

    const translator = getTranslator();
    let updated = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const fromDictionary = localisedTitle(row.category, language, row.title_en);

        const description =
          language === "en"
            ? row.description_en
            : await translator.translate(row.description_en, "en", language);

        const title =
          fromDictionary ??
          (language === "en" ? row.title_en : await translator.translate(row.title_en, "en", language));

        const { error: writeError } = await supabase
          .from("products")
          .update({
            title_local: title,
            description_local: description,
            local_language: language,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("user_id", req.uid);

        if (writeError) throw new Error(writeError.message);
        updated += 1;
      } catch (err) {
        failed += 1;
        console.error("relocalise failed for a product", {
          productId: row.id,
          to: language,
          message: (err as Error)?.message,
        });
      }
    }

    const { count } = await supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("user_id", req.uid)
      .neq("local_language", language);

    res.json({ updated, failed, remaining: count ?? 0 });
  }),
);

export default router;
