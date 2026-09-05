import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN_A = `roles-artisan-a-${Date.now()}@example.com`;
const EMAIL_ARTISAN_B = `roles-artisan-b-${Date.now()}@example.com`;
const EMAIL_BUYER = `roles-buyer-${Date.now()}@example.com`;
const EMAIL_ADMIN = `roles-admin-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase().from("products").select("flagged").limit(1);
  schemaReady = !error;
  if (!schemaReady) {
    console.warn(
      "Skipping role tests: this database predates the roles migration. " +
        "Run supabase/migrations/002-roles.sql first.",
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
  emails: [EMAIL_ARTISAN_A, EMAIL_ARTISAN_B, EMAIL_BUYER, EMAIL_ADMIN],
};

async function signIn(email: string): Promise<{ token: string; userId: string }> {
  await fetch(`${base}/api/auth/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, otp: FALLBACK }),
  });
  const body = await json<{ token: string; userId: string }>(res);
  created.users.push(body.userId);
  return body;
}

async function signInAs(email: string, role: "artisan" | "buyer" | "admin"): Promise<{ token: string; userId: string }> {
  const account = await signIn(email);
  if (role !== "artisan") {
    const { error } = await getSupabase().from("users").update({ role }).eq("id", account.userId);
    if (error) throw new Error(`Could not seed role ${role} for the test: ${error.message}`);
  }
  return account;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function json<T = any>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function createPublishedProduct(token: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "pottery",
      titleEn: "Pottery",
      titleLocal: "मिट्टी",
      localLanguage: "hi",
      descriptionEn: "A role-test product",
      descriptionLocal: "भूमिका परीक्षण उत्पाद",
      imageUrl: "https://example.com/role-test.jpg",
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
  if (created.users.length) await sb.from("users").delete().in("id", created.users);
  if (created.emails.length) await sb.from("otp_codes").delete().in("email", created.emails);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

suite("three role model", () => {
  it("PASS/FAIL: artisan cannot read another artisan's product row", async () => {
    const a = await signInAs(EMAIL_ARTISAN_A, "artisan");
    const b = await signInAs(EMAIL_ARTISAN_B, "artisan");
    const productId = await createPublishedProduct(a.token);

    const bList = await json<Array<{ productId: string }>>(
      await fetch(`${base}/api/products`, { headers: auth(b.token) }),
    );

    expect(bList.some((p) => p.productId === productId)).toBe(false);
  });

  it("PASS/FAIL: artisan cannot update their own role column", async () => {
    const a = await signInAs(EMAIL_ARTISAN_A, "artisan");

    const patchRes = await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(a.token), "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin", displayName: "Still Artisan" }),
    });
    expect(patchRes.status).toBe(200);

    const profile = await json<{ role: string }>(
      await fetch(`${base}/api/users/me`, { headers: auth(a.token) }),
    );
    expect(profile.role).toBe("artisan");
  });

  it("PASS/FAIL: buyer cannot insert or update a product", async () => {
    const a = await signInAs(EMAIL_ARTISAN_A, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createPublishedProduct(a.token);

    const insertRes = await fetch(`${base}/api/products`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "pottery",
        titleEn: "Pottery",
        titleLocal: "मिट्टी",
        localLanguage: "hi",
        descriptionEn: "Buyer attempt",
        descriptionLocal: "खरीदार प्रयास",
        imageUrl: "https://example.com/buyer.jpg",
        price: 500,
        materialCost: 100,
      }),
    });
    expect(insertRes.status).toBe(403);

    const updateRes = await fetch(`${base}/api/products/${productId}`, {
      method: "PATCH",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ price: 1 }),
    });
    expect(updateRes.status).toBe(403);
  });

  it("PASS/FAIL: buyer can read a published product", async () => {
    const a = await signInAs(EMAIL_ARTISAN_A, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createPublishedProduct(a.token);

    const marketplace = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/products/marketplace`, { headers: auth(buyer.token) }),
    );

    expect(marketplace.items.some((p) => p.productId === productId)).toBe(true);
  });

  it("PASS/FAIL: admin can read all of an artisan's products regardless of status", async () => {
    const a = await signInAs(EMAIL_ARTISAN_A, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    const productId = await createPublishedProduct(a.token);

    const detail = await json<{ listings: Array<{ productId: string }> }>(
      await fetch(`${base}/api/internal/console/artisans/${a.userId}`, { headers: auth(admin.token) }),
    );

    expect(detail.listings.map((p) => p.productId)).toContain(productId);
  });

  it("PASS/FAIL: admin can update a moderation field", async () => {
    const a = await signInAs(EMAIL_ARTISAN_A, "artisan");
    const admin = await signInAs(EMAIL_ADMIN, "admin");
    const productId = await createPublishedProduct(a.token);

    const flagRes = await fetch(`${base}/api/internal/console/moderation/${productId}/flag`, {
      method: "PATCH",
      headers: { ...auth(admin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "role verification test" }),
    });
    expect(flagRes.status).toBe(200);

    const detail = await json<{ listings: Array<{ productId: string; flagged: boolean; flagReason: string | null }> }>(
      await fetch(`${base}/api/internal/console/artisans/${a.userId}`, { headers: auth(admin.token) }),
    );
    const updated = detail.listings.find((p) => p.productId === productId);

    expect(updated?.flagged).toBe(true);
    expect(updated?.flagReason).toBe("role verification test");
  });

  it("PASS/FAIL: a non-admin hitting the console API gets 404, not 403", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN_A, "artisan");

    const res = await fetch(`${base}/api/internal/console/dashboard`, { headers: auth(artisan.token) });
    expect(res.status).toBe(404);

    const anonRes = await fetch(`${base}/api/internal/console/dashboard`);
    expect(anonRes.status).toBe(404);
  });
});

suite("self-serve role choice at signup", () => {
  async function verifyWithRole(email: string, intendedRole: "artisan" | "buyer") {
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

  it("PASS/FAIL: a brand new signup becomes the role it chose", async () => {
    const email = `roles-selfserve-buyer-${Date.now()}@example.com`;
    created.emails.push(email);

    const res = await verifyWithRole(email, "buyer");
    const body = await json<{ userId: string; role: string }>(res);
    created.users.push(body.userId);

    expect(res.status).toBe(200);
    expect(body.role).toBe("buyer");
  });

  it("PASS/FAIL: an existing account's role does not change on a later login", async () => {
    const email = `roles-selfserve-existing-${Date.now()}@example.com`;
    created.emails.push(email);

    const first = await verifyWithRole(email, "artisan");
    const firstBody = await json<{ userId: string; role: string }>(first);
    created.users.push(firstBody.userId);
    expect(firstBody.role).toBe("artisan");

    const second = await verifyWithRole(email, "buyer");
    const secondBody = await json<{ userId: string; role: string }>(second);

    expect(secondBody.userId).toBe(firstBody.userId);
    expect(secondBody.role).toBe("artisan");
  });

  it("PASS/FAIL: intendedRole cannot be admin, even as a raw request", async () => {
    const email = `roles-selfserve-admin-attempt-${Date.now()}@example.com`;
    created.emails.push(email);

    await fetch(`${base}/api/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const res = await fetch(`${base}/api/auth/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp: FALLBACK, intendedRole: "admin" }),
    });

    expect(res.status).toBe(400);
  });
});
