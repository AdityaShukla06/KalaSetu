import jwt from "jsonwebtoken";
import { loadEnv } from "./env";

export interface SessionClaims {
  sub: string;
  email: string;
}

export function signSessionToken(claims: SessionClaims): string {
  const env = loadEnv();
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifySessionToken(token: string): SessionClaims {
  const env = loadEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET);

  if (typeof decoded === "string" || !decoded.sub || typeof decoded.sub !== "string") {
    throw new Error("Session token is missing a subject");
  }

  const email = (decoded as jwt.JwtPayload).email;
  if (typeof email !== "string") {
    throw new Error("Session token is missing an email");
  }

  return { sub: decoded.sub, email };
}
