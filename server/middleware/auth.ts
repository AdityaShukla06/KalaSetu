import { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../lib/jwt";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();

  try {
    const claims = verifySessionToken(token);
    req.uid = claims.sub;
    req.email = claims.email;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
