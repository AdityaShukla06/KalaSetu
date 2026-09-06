import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";
import { hashPassword } from "./lib/password";

let server: Server;
let base: string;

const EMAIL_ADMIN_WITH_PASSWORD = `admin-login-${Date.now()}@example.com`;
const EMAIL_ADMIN_NO_PASSWORD = `admin-login-no-pw-${Date.now()}@example.com`;
const EMAIL_NON_ADMIN = `admin-login-non-admin-${Date.now()}@example.com`;
const PASSWORD = "correct horse battery staple";
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase().from("users").select("password_hash, failed_login_attempts, locked_until").limit(1);
  schemaReady = !error;
  if (!schemaReady) {
    console.warn(
      "Skipping admin password login tests: this database predates the admin password migration. " +
        "Run supabase/migrations/012-admin-password.sql first.",
    );
  }
});

const suite = HAS_CREDENTIALS ? describe : describe.skip;

beforeEach((ctx) => {
  if (!schemaReady) ctx.skip();
});

const created: { users: string[]; emails: string[] } = {
  users: [],
  emails: [EMAIL_ADMIN_WITH_PASSWORD, EMAIL_ADMIN_NO_PASSWORD, EMAIL_NON_ADMIN],
};

function json<T = any>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function createUser(email: string, role: "artisan" | "buyer" | "admin", passwordHash?: string): Promise<string> {
  const { data, error } = await getSupabase()
    .from("users")
    .insert({ email, role, password_hash: passwordHash ?? null })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create test user: ${error.message}`);
  created.users.push(data.id);
  return data.id;
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
  if (created.users.length) await sb.from("users").delete().in("id", created.users);
  if (created.emails.length) await sb.from("otp_codes").delete().in("email", created.emails);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

suite("admin password login", () => {
  it("PASS/FAIL: request-otp tells the client an admin with a password should use it instead, and sends no OTP", async () => {
    await createUser(EMAIL_ADMIN_WITH_PASSWORD, "admin", hashPassword(PASSWORD));

    const res = await fetch(`${base}/api/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL_ADMIN_WITH_PASSWORD }),
    });
    const body = await json<{ requiresPassword: boolean; emailDelivered: boolean }>(res);

    expect(body.requiresPassword).toBe(true);
    expect(body.emailDelivered).toBe(false);

    const { count } = await getSupabase()
      .from("otp_codes")
      .select("*", { count: "exact", head: true })
      .eq("email", EMAIL_ADMIN_WITH_PASSWORD);
    expect(count).toBe(0);
  }, 15000);

  it("PASS/FAIL: an admin without a password set yet still goes through the normal OTP flow", async () => {
    await createUser(EMAIL_ADMIN_NO_PASSWORD, "admin");

    const res = await fetch(`${base}/api/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL_ADMIN_NO_PASSWORD }),
    });
    const body = await json<{ requiresPassword: boolean }>(res);

    expect(body.requiresPassword).toBe(false);
  }, 15000);

  it("PASS/FAIL: signs in with the correct password", async () => {
    const email = `admin-login-correct-${Date.now()}@example.com`;
    created.emails.push(email);
    await createUser(email, "admin", hashPassword(PASSWORD));

    const res = await fetch(`${base}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ token: string; role: string }>(res);
    expect(body.role).toBe("admin");
    expect(typeof body.token).toBe("string");
  }, 15000);

  it("PASS/FAIL: rejects a wrong password without saying which part is wrong", async () => {
    const email = `admin-login-wrong-${Date.now()}@example.com`;
    created.emails.push(email);
    await createUser(email, "admin", hashPassword(PASSWORD));

    const res = await fetch(`${base}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "wrong password" }),
    });
    expect(res.status).toBe(401);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("invalid_credentials");
  }, 15000);

  it("PASS/FAIL: a non-admin account, and an admin with no password set, cannot log in with a password", async () => {
    const noPasswordEmail = `admin-login-no-pw-standalone-${Date.now()}@example.com`;
    created.emails.push(noPasswordEmail);
    await createUser(EMAIL_NON_ADMIN, "artisan");
    await createUser(noPasswordEmail, "admin");

    const nonAdminRes = await fetch(`${base}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL_NON_ADMIN, password: "anything" }),
    });
    expect(nonAdminRes.status).toBe(401);

    const noPasswordRes = await fetch(`${base}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: noPasswordEmail, password: "anything" }),
    });
    expect(noPasswordRes.status).toBe(401);
  }, 15000);

  it("PASS/FAIL: locks the account for 15 minutes after 5 wrong passwords, then a correct one still fails until it clears", async () => {
    const email = `admin-login-lockout-${Date.now()}@example.com`;
    created.emails.push(email);
    await createUser(email, "admin", hashPassword(PASSWORD));

    let lastStatus = 0;
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/api/auth/admin-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "wrong" }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);

    const stillLockedRes = await fetch(`${base}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(stillLockedRes.status).toBe(429);
    const body = await json<{ error: string }>(stillLockedRes);
    expect(body.error).toBe("account_locked");
  }, 20000);

  it("PASS/FAIL: a deactivated admin cannot log in even with the correct password", async () => {
    const email = `admin-login-deactivated-${Date.now()}@example.com`;
    created.emails.push(email);
    const { data, error } = await getSupabase()
      .from("users")
      .insert({ email, role: "admin", password_hash: hashPassword(PASSWORD), is_active: false })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    created.users.push(data.id);

    const res = await fetch(`${base}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(res.status).toBe(403);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("account_deactivated");
  }, 15000);
});
