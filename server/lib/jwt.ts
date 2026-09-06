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

export type TicketType = "deactivation" | "product_removal";

export interface TicketClaims {
  purpose: "raise_ticket";
  sub: string;
  ticketType: TicketType;
  context?: string;
}

const TICKET_TOKEN_TTL = "30d";

export function signTicketToken(claims: Omit<TicketClaims, "purpose">): string {
  const env = loadEnv();
  return jwt.sign({ ...claims, purpose: "raise_ticket" }, env.JWT_SECRET, {
    expiresIn: TICKET_TOKEN_TTL,
  } as jwt.SignOptions);
}

export function verifyTicketToken(token: string): TicketClaims {
  const env = loadEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET);

  if (typeof decoded === "string" || decoded.purpose !== "raise_ticket" || typeof decoded.sub !== "string") {
    throw new Error("Not a valid ticket link");
  }

  const ticketType = (decoded as jwt.JwtPayload).ticketType;
  if (ticketType !== "deactivation" && ticketType !== "product_removal") {
    throw new Error("Ticket link has an unrecognised type");
  }

  const context = (decoded as jwt.JwtPayload).context;

  return {
    purpose: "raise_ticket",
    sub: decoded.sub,
    ticketType,
    context: typeof context === "string" ? context : undefined,
  };
}
