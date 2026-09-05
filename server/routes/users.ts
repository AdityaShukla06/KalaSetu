import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { isAppLanguage } from "../../shared/languages";
import { isIndianRegion } from "../../shared/regions";
import { isValidWhatsAppNumber } from "../../shared/whatsapp";
import { UserProfile, isUserRole } from "../types";

const router = Router();

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  shop_name: string | null;
  region: string | null;
  whatsapp_number: string | null;
  language: string;
  role: string;
  total_products: number;
  created_at: string;
}

export function toUserProfile(row: UserRow): UserProfile {
  return {
    userId: row.id,
    email: row.email,
    displayName: row.display_name,
    shopName: row.shop_name,
    region: row.region,
    whatsappNumber: row.whatsapp_number,
    language: isAppLanguage(row.language) ? row.language : "en",
    role: isUserRole(row.role) ? row.role : "artisan",
    totalProducts: row.total_products,
    createdAt: row.created_at,
  };
}

router.get(
  "/me",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const supabase = getSupabase();
    let { data, error } = await supabase
      .from("users")
      .select("id, email, display_name, shop_name, region, whatsapp_number, language, role, total_products, created_at")
      .eq("id", req.uid)
      .maybeSingle();

    if (error?.code === "42703") {
      const fallback = await supabase
        .from("users")
        .select("id, email, display_name, shop_name, region, language, role, total_products, created_at")
        .eq("id", req.uid)
        .maybeSingle();
      data = fallback.data ? { ...fallback.data, whatsapp_number: null } : null;
      error = fallback.error;
    }

    if (error) throw new Error(`Could not load the profile: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(toUserProfile(data as UserRow));
  }),
);

const UpdateUserSchema = z.object({
  displayName: z.string().max(80).optional(),
  shopName: z.string().max(120).optional(),
  region: z.string().refine(isIndianRegion, "Unsupported region").optional(),
  whatsappNumber: z
    .string()
    .refine((value) => value === "" || isValidWhatsAppNumber(value), "Enter a valid phone number")
    .optional(),
  language: z.string().refine(isAppLanguage, "Unsupported language").optional(),
});

router.patch(
  "/me",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.displayName !== undefined) patch.display_name = parsed.data.displayName;
    if (parsed.data.shopName !== undefined) patch.shop_name = parsed.data.shopName;
    if (parsed.data.region !== undefined) patch.region = parsed.data.region;
    if (parsed.data.whatsappNumber !== undefined) {
      patch.whatsapp_number = parsed.data.whatsappNumber === "" ? null : parsed.data.whatsappNumber;
    }
    if (parsed.data.language !== undefined) patch.language = parsed.data.language;

    if (Object.keys(patch).length === 0) {
      res.json({ success: true });
      return;
    }

    const { error } = await getSupabase().from("users").update(patch).eq("id", req.uid);
    if (error) throw new Error(`Could not update the profile: ${error.message}`);

    res.json({ success: true });
  }),
);

export default router;
