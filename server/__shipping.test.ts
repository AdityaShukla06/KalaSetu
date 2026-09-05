import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `shipping-artisan-${Date.now()}@example.com`;
const EMAIL_BUYER = `shipping-buyer-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const [productsCheck, usersCheck] = await Promise.all([
    getSupabase().from("products").select("weight_kg").limit(1),
    getSupabase().from("users").select("pincode").limit(1),
  ]);
  schemaReady = !productsCheck.error && !usersCheck.error;
  if (!schemaReady) {
    console.warn(
      "Skipping shipping estimate tests: this database predates the shipping estimate migration. " +
        "Run supabase/migrations/009-shipping-estimate.sql first.",
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
  emails: [EMAIL_ARTISAN, EMAIL_BUYER],
};

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

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function json<T = any>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function createProduct(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "pottery",
      material: "Clay",
      titleEn: "Shipping Test Vase",
      titleLocal: "शिपिंग परीक्षण फूलदान",
      localLanguage: "hi",
      descriptionEn: "A distinctive test vase for the shipping estimate test suite",
      descriptionLocal: "शिपिंग परीक्षण के लिए एक विशिष्ट फूलदान",
      imageUrl: "https://example.com/shipping-test.jpg",
      price: 500,
      materialCost: 100,
      ...overrides,
    }),
  });
  const body = await json<{ productId: string }>(res);
  if (res.status !== 201) throw new Error(`Could not create test product: ${JSON.stringify(body)}`);
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

suite("rule-based shipping estimate", () => {
  it("PASS/FAIL: an artisan can set and clear an optional pincode on their profile", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");

    const setRes = await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ pincode: "560001" }),
    });
    expect(setRes.status).toBe(200);

    const profile = await json<{ pincode: string | null }>(
      await fetch(`${base}/api/users/me`, { headers: auth(artisan.token) }),
    );
    expect(profile.pincode).toBe("560001");

    await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ pincode: "" }),
    });

    const cleared = await json<{ pincode: string | null }>(
      await fetch(`${base}/api/users/me`, { headers: auth(artisan.token) }),
    );
    expect(cleared.pincode).toBeNull();
  }, 15000);

  it("PASS/FAIL: rejects an invalid pincode", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const res = await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ pincode: "12345" }),
    });
    expect(res.status).toBe(400);
  }, 15000);

  it("PASS/FAIL: a product can be created with an approximate weight", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const productId = await createProduct(artisan.token, { weightKg: 1.2 });

    const { data } = await getSupabase().from("products").select("weight_kg").eq("id", productId).single();
    expect(Number(data?.weight_kg)).toBe(1.2);
  }, 15000);

  it("PASS/FAIL: a product without a weight is still created successfully", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const productId = await createProduct(artisan.token);

    const { data } = await getSupabase().from("products").select("weight_kg").eq("id", productId).single();
    expect(data?.weight_kg).toBeNull();
  }, 15000);

  it("PASS/FAIL: the marketplace product detail exposes weight and the artisan's pincode for the shipping estimate", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ pincode: "560001" }),
    });
    const productId = await createProduct(artisan.token, { weightKg: 2 });

    const body = await json<{ weightKg?: number; artisan: { pincode: string | null } }>(
      await fetch(`${base}/api/products/marketplace/${productId}`, { headers: auth(buyer.token) }),
    );

    expect(body.weightKg).toBe(2);
    expect(body.artisan.pincode).toBe("560001");
  }, 15000);

  it("PASS/FAIL: My Shop exposes the product's own weight back to the artisan", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const productId = await createProduct(artisan.token, { weightKg: 3.5 });

    const list = await json<Array<{ productId: string; weightKg?: number }>>(
      await fetch(`${base}/api/products`, { headers: auth(artisan.token) }),
    );
    const listed = list.find((item) => item.productId === productId);
    expect(listed?.weightKg).toBe(3.5);
  }, 15000);
});
