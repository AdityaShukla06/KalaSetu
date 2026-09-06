import { Router, Request, Response } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { verifyTicketToken } from "../lib/jwt";

const router = Router();

const TICKET_TYPE_LABEL: Record<string, string> = {
  deactivation: "Your account was deactivated",
  product_removal: "One of your listings was removed",
};

const RaiseTicketSchema = z.object({
  token: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
});

router.post(
  "/",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = RaiseTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    let claims;
    try {
      claims = verifyTicketToken(parsed.data.token);
    } catch {
      res.status(400).json({ error: "invalid_or_expired_link" });
      return;
    }

    const { data, error } = await getSupabase()
      .from("support_tickets")
      .insert({
        artisan_id: claims.sub,
        ticket_type: claims.ticketType,
        context: claims.context ?? null,
        message: parsed.data.message,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Could not save the ticket: ${error.message}`);

    res.status(201).json({ ticketId: data.id });
  }),
);

router.get(
  "/preview",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const token = (req.query.token as string | undefined) ?? "";
    let claims;
    try {
      claims = verifyTicketToken(token);
    } catch {
      res.status(400).json({ error: "invalid_or_expired_link" });
      return;
    }

    res.json({
      ticketType: claims.ticketType,
      title: TICKET_TYPE_LABEL[claims.ticketType] ?? "Contact support",
      context: claims.context ?? null,
    });
  }),
);

export default router;
