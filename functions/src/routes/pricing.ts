import { Router, Request, Response } from "express";
import { verifyFirebaseToken } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { z } from "zod";
import { calculateSmartPrice, ComplexityLevel } from "../services/pricingEngine";

const router = Router();

const RawMaterialSchema = z.object({
  name: z.string().min(1),
  cost: z.number().positive(),
  quantity: z.union([z.number(), z.string()]).optional(),
  unit: z.string().optional(),
});

const PricingInputSchema = z
  .object({
    category: z.string().min(1),
    materialCost: z.number().positive().optional(),
    rawMaterials: z.array(RawMaterialSchema).optional(),
    descriptionEn: z.string().optional(),
    descriptionHi: z.string().optional(),
    imageUrl: z.string().url().optional().or(z.literal("")),
    complexity: z.enum(["simple", "standard", "detailed", "complex", "exceptional"]).optional(),
    subcategory: z.string().optional(),
  })
  .refine(
    (data) =>
      (data.materialCost !== undefined && data.materialCost > 0) ||
      (data.rawMaterials && data.rawMaterials.length > 0),
    {
      message: "Either materialCost or rawMaterials must be provided with positive values",
      path: ["materialCost"],
    },
  );

router.post(
  "/suggest",
  verifyFirebaseToken,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = PricingInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      const output = calculateSmartPrice({
        category: parsed.data.category,
        materialCost: parsed.data.materialCost,
        rawMaterials: parsed.data.rawMaterials,
        descriptionEn: parsed.data.descriptionEn,
        descriptionHi: parsed.data.descriptionHi,
        imageUrl: parsed.data.imageUrl,
        complexity: parsed.data.complexity as ComplexityLevel | undefined,
        subcategory: parsed.data.subcategory,
      });

      res.json(output);
    } catch (err: any) {
      res.status(500).json({
        error: "pricing_calculation_failed",
        message: err?.message || "Calculation error",
      });
    }
  }),
);

export default router;
