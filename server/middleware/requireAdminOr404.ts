import { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../lib/jwt";
import { getSupabase } from "../lib/supabase";
import { isUserRole } from "../types";

function notFound(res: Response): void {
  res.status(404).json({ error: "Not Found" });
}

export async function requireAdminOr404(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    notFound(res);
    return;
  }

  let uid: string;
  try {
    const claims = verifySessionToken(header.slice("Bearer ".length).trim());
    uid = claims.sub;
  } catch {
    notFound(res);
    return;
  }

  const { data, error } = await getSupabase().from("users").select("role").eq("id", uid).maybeSingle();
  if (error) {
    notFound(res);
    return;
  }

  const role = isUserRole(data?.role) ? data.role : undefined;
  if (role !== "admin") {
    notFound(res);
    return;
  }

  req.uid = uid;
  req.role = role;
  next();
}
