import { Request, Response, NextFunction } from "express";
import { getAuth } from "firebase-admin/auth";

export async function verifyFirebaseToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const idToken = header.split("Bearer ")[1];

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
