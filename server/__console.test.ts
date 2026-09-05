import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `console-artisan-${Date.now()}@example.com`;
const EMAIL_ADMIN = `console-admin-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase().from("products").select("review_status, reviewed_at, reviewed_by, review_reason").limit(1);
  const { error: userError } = await getSupabase().from("users").select("is_active").limit(1);
  const { error: auditError } = await getSupabase().from("audit_log").select("id").limit(1);
  schemaReady = !error && !userError && !auditError;
  if (!schemaReady) {
    console.warn(
      "Skipping console tests: this database predates the admin console migration. " +
        "Run supabase/migrations/004-admin-console.sql first.",
    );
  }
});

const suite = HAS_CREDENTIALS ? describe : describe.skip;

beforeEach((ctx) => {
  if (!schemaReady) ctx.skip();
});

const created: { users: string[]; products: string[]; emails: string[] } = {
  users: [],
  products: [],
  emails: [EMAIL_ARTISAN, EMAIL_ADMIN],
};

async function verifyRaw(email: string, intendedRole: "artisan" | "buyer" = "artisan") {
  await fetch(`${base}/api/auth/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return fetch(`${base}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, otp: FALLBACK, intendedRole }),
  });
}

async function signInAs(email: string, role: "artisan" | "admin"): Promise<{ token: string; userId: string }> {
  const res = await verifyRaw(email, "artisan");
  const body = await json<{ token: string; userId: string }>(res);
  created.users.push(body.userId);
  if (role === "admin") {
    const { error } = await getSupabase().from("users").update({ role: "admin" }).eq("id", body.userId);
    if (error) throw new Error(`Could not seed admin role: ${error.message}`);
  }
  return body;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function json<T = any>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function createPublishedProduct(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "pottery",
      titleEn: "Console Test Product",
      titleLocal: "कंसोल परीक्षण उत्पाद",
      localLanguage: "hi",
      descriptionEn: "A console test product",
      descriptionLocal: "एक कंसोल परीक्षण उत्पाद",
      imageUrl: "https://example.com/console-test.jpg",
      price: 500,
      materialCost: 100,
      ...overrides,
    }),
  });
  const body = await json<{ productId: string }>(res);
  created.products.push(body.productId);
  return body.productId;
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
  if (created.products.length) await sb.from("products").delete().in("id", created.products);
  if (created.users.length) {
    await sb.from("audit_log").delete().in("target_id", created.users);
    await sb.from("users").delete().in("id", created.users);
  }
  if (created.emails.length) await sb.from("otp_codes").delete().in("email", created.emails);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

suite("admin console access control", () => {
  it("PASS/FAIL: an unauthenticated request gets 404, not 401", async () => {
    const res = await fetch(`${base}/api/internal/console/dashboard`);
    expect(res.status).toBe(404);
  });

  it("PASS/FAIL: a non-admin gets 404, not 403", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const res = await fetch(`${base}/api/internal/console/artisans`, { headers: auth(artisan.token) });
    expect(res.status).toBe(404);
  });

  it("PASS/FAIL: an admin can reach the console", async () => {
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    const res = await fetch(`${base}/api/internal/console/dashboard`, { headers: auth(admin.token) });
    expect(res.status).toBe(200);
  });
});

suite("dashboard stats", () => {
  it("PASS/FAIL: reflects real counts", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    await createPublishedProduct(artisan.token);

    const stats = await json<{ totalArtisans: number; totalProducts: number; pendingApproval: number }>(
      await fetch(`${base}/api/internal/console/dashboard`, { headers: auth(admin.token) }),
    );

    expect(stats.totalArtisans).toBeGreaterThanOrEqual(1);
    expect(stats.totalProducts).toBeGreaterThanOrEqual(1);
    expect(stats.pendingApproval).toBeGreaterThanOrEqual(1);
  });
});

suite("artisan management", () => {
  it("PASS/FAIL: search finds an artisan by email", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");

    const result = await json<{ items: Array<{ userId: string }> }>(
      await fetch(`${base}/api/internal/console/artisans?q=${encodeURIComponent(EMAIL_ARTISAN)}`, {
        headers: auth(admin.token),
      }),
    );

    expect(result.items.some((item) => item.userId === artisan.userId)).toBe(true);
  });

  it("PASS/FAIL: deactivating an artisan blocks their next login, reactivating restores it", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");

    const deactivateRes = await fetch(`${base}/api/internal/console/artisans/${artisan.userId}`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false, reason: "test deactivation" }),
    });
    expect(deactivateRes.status).toBe(200);

    const blockedLogin = await verifyRaw(EMAIL_ARTISAN);
    expect(blockedLogin.status).toBe(403);
    expect((await json<{ error: string }>(blockedLogin)).error).toBe("account_deactivated");

    const reactivateRes = await fetch(`${base}/api/internal/console/artisans/${artisan.userId}`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    expect(reactivateRes.status).toBe(200);

    const restoredLogin = await verifyRaw(EMAIL_ARTISAN);
    expect(restoredLogin.status).toBe(200);
  });

  it("PASS/FAIL: deactivation writes an audit row", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");

    await fetch(`${base}/api/internal/console/artisans/${artisan.userId}`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false, reason: "audit test" }),
    });

    const auditEntries = await json<Array<{ action: string; targetId: string; reason: string | null }>>(
      await fetch(`${base}/api/internal/console/audit?limit=50`, { headers: auth(admin.token) }),
    );

    const entry = auditEntries.find((e) => e.action === "artisan.deactivate" && e.targetId === artisan.userId);
    expect(entry?.reason).toBe("audit test");
  });
});

suite("listing moderation", () => {
  it("PASS/FAIL: the queue only shows pending review listings", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    const productId = await createPublishedProduct(artisan.token);

    await fetch(`${base}/api/internal/console/moderation/${productId}/approve`, {
      method: "PATCH",
      headers: auth(admin.token),
    });

    const queue = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/internal/console/moderation/queue?limit=100`, { headers: auth(admin.token) }),
    );

    expect(queue.items.some((item) => item.productId === productId)).toBe(false);
  });

  it("PASS/FAIL: approve marks reviewed without touching marketplace visibility", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    const productId = await createPublishedProduct(artisan.token);

    await fetch(`${base}/api/internal/console/moderation/${productId}/approve`, {
      method: "PATCH",
      headers: auth(admin.token),
    });

    const detail = await json<{ listings: Array<{ productId: string; status: string; reviewStatus: string }> }>(
      await fetch(`${base}/api/internal/console/artisans/${artisan.userId}`, { headers: auth(admin.token) }),
    );
    const listing = detail.listings.find((l) => l.productId === productId);

    expect(listing?.reviewStatus).toBe("approved");
    expect(listing?.status).toBe("published");
  });

  it("PASS/FAIL: reject requires a reason and pulls the listing from the marketplace", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    const productId = await createPublishedProduct(artisan.token);

    const noReasonRes = await fetch(`${base}/api/internal/console/moderation/${productId}/reject`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "" }),
    });
    expect(noReasonRes.status).toBe(400);

    const rejectRes = await fetch(`${base}/api/internal/console/moderation/${productId}/reject`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "price looks fabricated" }),
    });
    expect(rejectRes.status).toBe(200);

    const detail = await json<{
      listings: Array<{ productId: string; status: string; reviewStatus: string; reviewReason: string | null }>;
    }>(await fetch(`${base}/api/internal/console/artisans/${artisan.userId}`, { headers: auth(admin.token) }));
    const listing = detail.listings.find((l) => l.productId === productId);

    expect(listing?.reviewStatus).toBe("rejected");
    expect(listing?.status).toBe("draft");
    expect(listing?.reviewReason).toBe("price looks fabricated");

    const marketplace = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/products/marketplace`, { headers: auth(admin.token) }),
    );
    expect(marketplace.items.some((item) => item.productId === productId)).toBe(false);
  });

  it("PASS/FAIL: flag pulls the listing from the marketplace via the existing flagged column", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    const productId = await createPublishedProduct(artisan.token);

    const flagRes = await fetch(`${base}/api/internal/console/moderation/${productId}/flag`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "suspected overcharge" }),
    });
    expect(flagRes.status).toBe(200);

    const marketplace = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/products/marketplace`, { headers: auth(artisan.token) }),
    );
    expect(marketplace.items.some((item) => item.productId === productId)).toBe(false);

    const auditEntries = await json<Array<{ action: string; targetId: string }>>(
      await fetch(`${base}/api/internal/console/audit?limit=50`, { headers: auth(admin.token) }),
    );
    expect(auditEntries.some((e) => e.action === "product.flag" && e.targetId === productId)).toBe(true);
  });
});

suite("flagged listings", () => {
  it("PASS/FAIL: degrades gracefully when the auto-flag column does not exist", async () => {
    const admin = await signInAs(EMAIL_ADMIN, "admin");

    const res = await fetch(`${base}/api/internal/console/flagged`, { headers: auth(admin.token) });
    const body = await json<{ available: boolean; items: unknown[] }>(res);

    expect(res.status).toBe(200);
    expect(typeof body.available).toBe("boolean");
    if (!body.available) {
      expect(body.items).toEqual([]);
    }
  });
});
