import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { Product, ProductStatus, ProductWithArtisan, ProductWithViewCount } from "../types";
import { buildVoiceAiDependencies } from "../voice-ai";
import { generatePassportId } from "../lib/passportId";
import { calculateSmartPrice, assessOvercharge } from "../services/pricingEngine";
import { isAppLanguage } from "../../shared/languages";
import { DICTIONARIES } from "../../shared/locales";
import { isProductMaterial } from "../../shared/materials";
import { isIndianRegion } from "../../shared/regions";

const router = Router();

const MAX_RELOCALISE = 25;
const MAX_OWN_VIEW_ROWS = 5000;

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

function getVoiceDeps() {
  if (!voiceDeps) {
    voiceDeps = buildVoiceAiDependencies({
      logger: {
        info: () => {},
        warn: (m: string, meta?: Record<string, unknown>) => console.warn("[products]", m, meta || ""),
        error: (m: string, meta?: Record<string, unknown>) => console.error("[products]", m, meta || ""),
      },
    });
  }
  return voiceDeps;
}

function getTranslator() {
  return getVoiceDeps().translationService;
}

async function generateHeritageStorySafely(input: {
  category: string;
  descriptionEn: string;
  material?: string;
  technique?: string;
  timeTaken?: string;
  giTag?: string;
}): Promise<string | null> {
  try {
    return await getVoiceDeps().descriptionService.generateHeritageStory(input);
  } catch (err) {
    console.warn("[products] heritage story generation failed, passport will show no story for now", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function assessOverchargeSafely(input: {
  category: string;
  materialCost: number;
  descriptionEn: string;
  imageUrl: string;
  price: number;
}): string | null {
  try {
    const suggestion = calculateSmartPrice({
      category: input.category,
      materialCost: input.materialCost,
      descriptionEn: input.descriptionEn,
      imageUrl: input.imageUrl,
    });
    return assessOvercharge(suggestion, input.price).reason;
  } catch (err) {
    console.warn("[products] overcharge assessment failed, skipping auto-flag", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const PRODUCT_COLUMNS =
  "id, user_id, category, material, region, artisan_name, title_en, title_local, description_en, description_local, local_language, image_url, price, material_cost, status, flagged, flag_reason, auto_flag_reason, review_status, reviewed_at, reviewed_by, review_reason, passport_id, technique, time_taken, gi_tag, care_instructions, product_story, story_generated_at, created_at, updated_at";

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
  auto_flag_reason: string | null;
  review_status: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_reason: string | null;
  passport_id: string;
  technique: string | null;
  time_taken: string | null;
  gi_tag: string | null;
  care_instructions: string | null;
  product_story: string | null;
  story_generated_at: string | null;
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
    autoFlagReason: row.auto_flag_reason,
    reviewStatus: row.review_status as Product["reviewStatus"],
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewReason: row.review_reason,
    technique: row.technique ?? undefined,
    timeTaken: row.time_taken ?? undefined,
    giTag: row.gi_tag ?? undefined,
    careInstructions: row.care_instructions ?? undefined,
    passportId: row.passport_id,
    productStory: row.product_story,
    storyGeneratedAt: row.story_generated_at,
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
  technique: z.string().trim().min(1).max(120).optional(),
  timeTaken: z.string().trim().min(1).max(60).optional(),
  giTag: z.string().trim().min(1).max(120).optional(),
  careInstructions: z.string().trim().min(1).max(500).optional(),
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
  if (input.technique !== undefined) row.technique = input.technique;
  if (input.timeTaken !== undefined) row.time_taken = input.timeTaken;
  if (input.giTag !== undefined) row.gi_tag = input.giTag;
  if (input.careInstructions !== undefined) row.care_instructions = input.careInstructions;
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

    const passportId = await generatePassportId();
    const story = await generateHeritageStorySafely({
      category: parsed.data.category,
      descriptionEn: parsed.data.descriptionEn,
      material: parsed.data.material,
      technique: parsed.data.technique,
      timeTaken: parsed.data.timeTaken,
      giTag: parsed.data.giTag,
    });
    const autoFlagReason = assessOverchargeSafely({
      category: parsed.data.category,
      materialCost: parsed.data.materialCost,
      descriptionEn: parsed.data.descriptionEn,
      imageUrl: parsed.data.imageUrl,
      price: parsed.data.price,
    });

    const { data, error } = await supabase
      .from("products")
      .insert({
        ...toRow(parsed.data),
        user_id: req.uid,
        status: "published",
        artisan_name: artisanName,
        region: artisan?.region ?? null,
        passport_id: passportId,
        product_story: story,
        story_generated_at: story ? new Date().toISOString() : null,
        auto_flag_reason: autoFlagReason,
      })
      .select("id, passport_id")
      .single();

    if (error) throw new Error(`Could not create the product: ${error.message}`);

    await supabase.rpc("increment_total_products", { target_user: req.uid, delta: 1 });

    res.status(201).json({ productId: data.id, passportId: data.passport_id });
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

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("user_id", req.uid)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not list products: ${error.message}`);

    const rows = data as ProductRow[];
    const productIds = rows.map((row) => row.id);

    let viewCountByProduct = new Map<string, number>();
    if (productIds.length > 0) {
      const { data: viewRows, error: viewError } = await supabase
        .from("product_views")
        .select("product_id")
        .in("product_id", productIds)
        .limit(MAX_OWN_VIEW_ROWS);

      if (viewError) {
        console.warn("[products] could not load view counts for My Shop, showing 0 for now", {
          message: viewError.message,
        });
      } else {
        viewCountByProduct = new Map();
        for (const row of viewRows ?? []) {
          const productId = row.product_id as string;
          viewCountByProduct.set(productId, (viewCountByProduct.get(productId) ?? 0) + 1);
        }
      }
    }

    const result: ProductWithViewCount[] = rows.map((row) => ({
      ...toProduct(row),
      viewCount: viewCountByProduct.get(row.id) ?? 0,
    }));

    res.json(result);
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

    let { data: artisan, error: artisanError } = await supabase
      .from("users")
      .select("id, shop_name, display_name, region, whatsapp_number, total_products")
      .eq("id", (product as ProductRow).user_id)
      .maybeSingle();

    if (artisanError?.code === "42703") {
      const fallback = await supabase
        .from("users")
        .select("id, shop_name, display_name, region, total_products")
        .eq("id", (product as ProductRow).user_id)
        .maybeSingle();
      artisan = fallback.data ? { ...fallback.data, whatsapp_number: null } : null;
      artisanError = fallback.error;
    }

    if (artisanError) throw new Error(`Could not load the artisan profile: ${artisanError.message}`);

    const result: ProductWithArtisan = {
      ...toProduct(product as ProductRow),
      artisan: {
        userId: artisan?.id ?? (product as ProductRow).user_id,
        shopName: artisan?.shop_name ?? null,
        displayName: artisan?.display_name ?? null,
        region: artisan?.region ?? null,
        whatsappNumber: artisan?.whatsapp_number ?? null,
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

    const { data: existing, error: existingError } = await supabase
      .from("products")
      .select("category, material_cost, price, description_en, image_url")
      .eq("id", req.params.id as string)
      .eq("user_id", req.uid)
      .maybeSingle();

    if (existingError) throw new Error(`Could not load the product: ${existingError.message}`);
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const autoFlagReason = assessOverchargeSafely({
      category: parsed.data.category ?? existing.category,
      materialCost: parsed.data.materialCost ?? Number(existing.material_cost),
      descriptionEn: parsed.data.descriptionEn ?? existing.description_en,
      imageUrl: parsed.data.imageUrl ?? existing.image_url,
      price: parsed.data.price ?? Number(existing.price),
    });

    const { data, error } = await supabase
      .from("products")
      .update({ ...toRow(parsed.data), auto_flag_reason: autoFlagReason, updated_at: new Date().toISOString() })
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
