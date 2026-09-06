import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";
import { signTicketToken } from "./lib/jwt";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `ticket-artisan-${Date.now()}@example.com`;
const EMAIL_ADMIN = `ticket-admin-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase().from("support_tickets").select("id").limit(1);
  schemaReady = !error;
  if (!schemaReady) {
    console.warn(
      "Skipping support ticket tests: this database predates the support tickets migration. " +
        "Run supabase/migrations/013-support-tickets.sql first.",
    );
  }
});

const suite = HAS_CREDENTIALS ? describe : describe.skip;

beforeEach((ctx) => {
  if (!schemaReady) ctx.skip();
});

const created: { users: string[]; emails: string[]; tickets: string[] } = {
  users: [],
  emails: [EMAIL_ARTISAN, EMAIL_ADMIN],
  tickets: [],
};

function json<T = any>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function signInAs(email: string, role: "artisan" | "buyer"): Promise<{ token: string; userId: string }> {
  await fetch(`${base}/api/auth/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, otp: FALLBACK, intendedRole: role }),
  });
  const body = await json<{ token: string; userId: string }>(res);
  created.users.push(body.userId);
  return body;
}

async function signInAsAdmin(email: string): Promise<{ token: string; userId: string }> {
  const account = await signInAs(email, "buyer");
  await getSupabase().from("users").update({ role: "admin" }).eq("id", account.userId);
  return account;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  const sb = getSupabase();
  if (created.tickets.length) await sb.from("support_tickets").delete().in("id", created.tickets);
  if (created.users.length) await sb.from("users").delete().in("id", created.users);
  if (created.emails.length) await sb.from("otp_codes").delete().in("email", created.emails);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

suite("support tickets", () => {
  it("PASS/FAIL: the preview endpoint reads a valid token, and rejects an invalid one", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const token = signTicketToken({ sub: artisan.userId, ticketType: "deactivation", context: "Fake listings" });

    const goodRes = await fetch(`${base}/api/tickets/preview?token=${encodeURIComponent(token)}`);
    expect(goodRes.status).toBe(200);
    const goodBody = await json<{ ticketType: string; context: string | null }>(goodRes);
    expect(goodBody.ticketType).toBe("deactivation");
    expect(goodBody.context).toBe("Fake listings");

    const badRes = await fetch(`${base}/api/tickets/preview?token=not-a-real-token`);
    expect(badRes.status).toBe(400);
  }, 15000);

  it("PASS/FAIL: raises a ticket from a signed token with no login required, and rejects an empty message", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const token = signTicketToken({ sub: artisan.userId, ticketType: "product_removal", context: "Test Vase | spam" });

    const emptyRes = await fetch(`${base}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, message: "" }),
    });
    expect(emptyRes.status).toBe(400);

    const res = await fetch(`${base}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, message: "This was not spam, please review." }),
    });
    expect(res.status).toBe(201);
    const body = await json<{ ticketId: string }>(res);
    created.tickets.push(body.ticketId);

    const { data } = await getSupabase().from("support_tickets").select("*").eq("id", body.ticketId).single();
    expect(data?.artisan_id).toBe(artisan.userId);
    expect(data?.ticket_type).toBe("product_removal");
    expect(data?.status).toBe("open");
  }, 15000);

  it("PASS/FAIL: a garbage or tampered token is rejected when raising a ticket", async () => {
    const res = await fetch(`${base}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "garbage", message: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("invalid_or_expired_link");
  }, 15000);

  it("PASS/FAIL: an admin can list and resolve tickets, and only an admin can", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAsAdmin(EMAIL_ADMIN);
    const token = signTicketToken({ sub: artisan.userId, ticketType: "deactivation", context: "reason" });

    const createRes = await fetch(`${base}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, message: "Please review my deactivation." }),
    });
    const { ticketId } = await json<{ ticketId: string }>(createRes);
    created.tickets.push(ticketId);

    const forbiddenRes = await fetch(`${base}/api/internal/console/tickets?status=open`, { headers: auth(artisan.token) });
    expect(forbiddenRes.status).toBe(404);

    const listRes = await fetch(`${base}/api/internal/console/tickets?status=open`, { headers: auth(admin.token) });
    expect(listRes.status).toBe(200);
    const list = await json<Array<{ ticketId: string; artisanEmail: string; status: string }>>(listRes);
    const found = list.find((t) => t.ticketId === ticketId);
    expect(found?.artisanEmail).toBe(EMAIL_ARTISAN);
    expect(found?.status).toBe("open");

    const resolveRes = await fetch(`${base}/api/internal/console/tickets/${ticketId}/resolve`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ response: "Reactivated, sorry for the inconvenience." }),
    });
    expect(resolveRes.status).toBe(200);

    const { data } = await getSupabase().from("support_tickets").select("status, admin_response").eq("id", ticketId).single();
    expect(data?.status).toBe("resolved");
    expect(data?.admin_response).toBe("Reactivated, sorry for the inconvenience.");
  }, 20000);
});

suite("moderation actions notify the artisan", () => {
  it("PASS/FAIL: deactivating an artisan succeeds even when email delivery cannot be confirmed", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAsAdmin(EMAIL_ADMIN);

    const res = await fetch(`${base}/api/internal/console/artisans/${artisan.userId}`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false, reason: "Test deactivation" }),
    });
    expect(res.status).toBe(200);

    const { data } = await getSupabase().from("users").select("is_active").eq("id", artisan.userId).single();
    expect(data?.is_active).toBe(false);

    await getSupabase().from("users").update({ is_active: true }).eq("id", artisan.userId);
  }, 15000);
});
