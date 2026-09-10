import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { z } from "zod";
import { calculateSmartPrice, CATEGORY_DATASET, ComplexityLevel } from "../services/pricingEngine";
import { getPricingServiceClient } from "../services/pricingServiceFactory";
import { mapPricingServiceResponse } from "../services/pricingServiceMapper";

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
    craftingTime: z.union([z.string(), z.number()]).optional(),
    state: z.string().optional(),
    hasGiTag: z.boolean().optional(),
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

export function totalMaterialCost(data: z.infer<typeof PricingInputSchema>): number | undefined {
  if (data.rawMaterials && data.rawMaterials.length > 0) {
    return data.rawMaterials.reduce((sum, item) => sum + item.cost, 0);
  }
  return data.materialCost;
}

router.post(
  "/suggest",
  requireAuth,
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = PricingInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;
    const materialCost = totalMaterialCost(data);
    const client = getPricingServiceClient();

    if (client && materialCost !== undefined) {
      try {
        const response = await client.estimate({
          category: data.category,
          materialCost,
          craftingTime: data.craftingTime,
          description: data.descriptionEn,
          state: data.state,
          hasGiTag: data.hasGiTag,
        });

        const categoryName = CATEGORY_DATASET[data.category.toLowerCase()]?.name ?? data.category;
        res.json(
          mapPricingServiceResponse(response, {
            complexity: data.complexity as ComplexityLevel | undefined,
            subcategory: data.subcategory ?? null,
            categoryName,
          }),
        );
        return;
      } catch (err: any) {
        console.warn("[pricing] pricing service unavailable, falling back to local engine", {
          reason: err?.reason,
          detail: err?.message?.slice(0, 200),
        });
      }
    }

    try {
      const output = calculateSmartPrice({
        category: data.category,
        materialCost: data.materialCost,
        rawMaterials: data.rawMaterials,
        descriptionEn: data.descriptionEn,
        descriptionHi: data.descriptionHi,
        imageUrl: data.imageUrl,
        complexity: data.complexity as ComplexityLevel | undefined,
        subcategory: data.subcategory,
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

export { PricingInputSchema };
export default router;
