import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `overcharge-artisan-${Date.now()}@example.com`;
const EMAIL_BUYER = `overcharge-buyer-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase().from("products").select("auto_flag_reason").limit(1);
  schemaReady = !error;
  if (!schemaReady) {
    console.warn(
      "Skipping pricing overcharge flag tests: this database predates that migration. " +
        "Run supabase/migrations/006-pricing-overcharge-flag.sql first.",
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

async function createProduct(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ productId: string; passportId: string; status: number }> {
  const res = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "pottery",
      material: "Clay",
      titleEn: "Overcharge Test Vase",
      titleLocal: "अधिक मूल्य परीक्षण फूलदान",
      localLanguage: "hi",
      descriptionEn: "A distinctive test vase for the overcharge flag test suite",
      descriptionLocal: "परीक्षण के लिए एक विशिष्ट फूलदान",
      imageUrl: "https://example.com/overcharge-test.jpg",
      price: 500,
      materialCost: 100,
      ...overrides,
    }),
  });
  const body = await json<{ productId: string; passportId: string }>(res);
  if (res.status === 201) created.products.push(body.productId);
  return { ...body, status: res.status };
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

suite("pricing overcharge auto-flag", () => {
  it("PASS/FAIL: leaves auto_flag_reason null for a reasonably priced product", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const { productId } = await createProduct(artisan.token, { materialCost: 100, price: 300 });

    const { data } = await getSupabase().from("products").select("auto_flag_reason").eq("id", productId).single();

    expect(data?.auto_flag_reason).toBeNull();
  });

  it("PASS/FAIL: sets a neutral, factual auto_flag_reason for a price far above the suggested range", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const { productId } = await createProduct(artisan.token, { materialCost: 100, price: 100000 });

    const { data } = await getSupabase()
      .from("products")
      .select("auto_flag_reason")
      .eq("id", productId)
      .single();

    expect(data?.auto_flag_reason).toBeTruthy();
    expect(data?.auto_flag_reason).toContain("Priced above typical range for this category");
    expect(data?.auto_flag_reason.toLowerCase()).not.toContain("overcharg");
    expect(data?.auto_flag_reason.toLowerCase()).not.toContain("seller");
  });

  it("PASS/FAIL: still creates the product even though it is priced far above range, pricing freedom is preserved", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const result = await createProduct(artisan.token, { materialCost: 100, price: 100000 });

    expect(result.status).toBe(201);
  });

  it("PASS/FAIL: does not hide an auto-flagged listing from the marketplace", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const { productId } = await createProduct(artisan.token, { materialCost: 100, price: 100000 });

    const res = await fetch(`${base}/api/products/marketplace/${productId}`, { headers: auth(buyer.token) });
    const body = await json<{ autoFlagReason: string | null }>(res);

    expect(res.status).toBe(200);
    expect(body.autoFlagReason).toContain("Priced above typical range for this category");
  });

  it("PASS/FAIL: recomputes the flag when the artisan edits the price on an existing listing", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const { productId } = await createProduct(artisan.token, { materialCost: 100, price: 300 });

    await fetch(`${base}/api/products/${productId}`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ price: 100000 }),
    });

    const { data } = await getSupabase().from("products").select("auto_flag_reason").eq("id", productId).single();
    expect(data?.auto_flag_reason).toContain("Priced above typical range for this category");
  });

  it("PASS/FAIL: clears the flag when the artisan edits the price back into range", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const { productId } = await createProduct(artisan.token, { materialCost: 100, price: 100000 });

    await fetch(`${base}/api/products/${productId}`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ price: 300 }),
    });

    const { data } = await getSupabase().from("products").select("auto_flag_reason").eq("id", productId).single();
    expect(data?.auto_flag_reason).toBeNull();
  });
});
