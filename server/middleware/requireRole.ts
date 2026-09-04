import { Request, Response, NextFunction } from "express";
import { getSupabase } from "../lib/supabase";
import { UserRole, isUserRole } from "../types";

export function requireRole(...allowed: UserRole[]) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const { data, error } = await getSupabase()
      .from("users")
      .select("role")
      .eq("id", req.uid)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: "internal_error" });
      return;
    }

    const role = isUserRole(data?.role) ? data.role : undefined;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    req.role = role;
    next();
  };
}
