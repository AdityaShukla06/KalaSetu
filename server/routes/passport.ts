import { Router, Request, Response } from "express";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { PRODUCT_COLUMNS, ProductRow } from "./products";
import { PublicPassport } from "../types";

const router = Router();

router.get(
  "/:passportId",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const passportId = req.params.passportId as string;

    const { data, error } = await getSupabase()
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("passport_id", passportId)
      .eq("status", "published")
      .eq("flagged", false)
      .maybeSingle();

    if (error) throw new Error(`Could not load the passport: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: "Passport not found" });
      return;
    }

    const row = data as ProductRow;
    const passport: PublicPassport = {
      passportId: row.passport_id,
      titleEn: row.title_en,
      titleLocal: row.title_local,
      localLanguage: row.local_language,
      category: row.category,
      technique: row.technique,
      material: row.material,
      timeTaken: row.time_taken,
      giTag: row.gi_tag,
      careInstructions: row.care_instructions,
      imageUrl: row.image_url,
      artisanName: row.artisan_name,
      region: row.region,
      createdAt: row.created_at,
      productStory: row.product_story,
    };

    res.json(passport);
  }),
);

export default router;
