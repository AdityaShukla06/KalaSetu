import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `analytics-artisan-${Date.now()}@example.com`;
const EMAIL_BUYER = `analytics-buyer-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const [viewsCheck, productsCheck] = await Promise.all([
    getSupabase().from("product_views").select("id").limit(1),
    getSupabase().from("products").select("auto_flag_reason").limit(1),
  ]);
  schemaReady = !viewsCheck.error && !productsCheck.error;
  if (!schemaReady) {
    console.warn(
      "Skipping analytics tests: this database predates the view tracking migration, or the pricing " +
        "overcharge flag migration product creation depends on. Run supabase/migrations/006-pricing-overcharge-flag.sql " +
        "and supabase/migrations/007-product-views.sql first.",
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
      titleEn: "Analytics Test Vase",
      titleLocal: "विश्लेषण परीक्षण फूलदान",
      localLanguage: "hi",
      descriptionEn: "A distinctive test vase for the analytics test suite",
      descriptionLocal: "विश्लेषण परीक्षण के लिए एक विशिष्ट फूलदान",
      imageUrl: "https://example.com/analytics-test.jpg",
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

suite("view tracking and artisan analytics", () => {
  it("PASS/FAIL: records a view when a buyer opens a product", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/analytics/view`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    });

    expect(res.status).toBe(201);

    const { data } = await getSupabase().from("product_views").select("viewer_role").eq("product_id", productId);
    expect(data?.length).toBe(1);
    expect(data?.[0]?.viewer_role).toBe("buyer");
  }, 15000);

  it("PASS/FAIL: rejects a view recorded by a non-buyer role", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const productId = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/analytics/view`, {
      method: "POST",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    });

    expect(res.status).toBe(403);
  }, 15000);

  it("PASS/FAIL: does not record a view for a draft product", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);
    await getSupabase().from("products").update({ status: "draft" }).eq("id", productId);

    const res = await fetch(`${base}/api/analytics/view`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    });

    expect(res.status).toBe(404);
  }, 15000);

  it("PASS/FAIL: an artisan with no products gets an honest, zeroed summary", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");

    const res = await fetch(`${base}/api/analytics/summary`, { headers: auth(artisan.token) });
    const body = await json<{
      totalViews: number;
      totalInquiries: number;
      activeListings: number;
      listings: unknown[];
      viewsOverTime: Array<{ count: number }>;
    }>(res);

    expect(res.status).toBe(200);
    expect(body.totalViews).toBe(0);
    expect(body.totalInquiries).toBe(0);
    expect(body.activeListings).toBe(0);
    expect(body.listings).toEqual([]);
    expect(body.viewsOverTime.every((point) => point.count === 0)).toBe(true);
  }, 15000);

  it("PASS/FAIL: a buyer cannot read the artisan analytics summary", async () => {
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const res = await fetch(`${base}/api/analytics/summary`, { headers: auth(buyer.token) });
    expect(res.status).toBe(403);
  }, 15000);

  it("PASS/FAIL: summary totals and per-listing stats reflect real recorded views and inquiries", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    for (let i = 0; i < 3; i += 1) {
      await getSupabase().from("product_views").insert({ product_id: productId, viewer_role: "buyer" });
    }
    await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Is this available in blue?" }),
    });

    const res = await fetch(`${base}/api/analytics/summary`, { headers: auth(artisan.token) });
    const body = await json<{
      totalViews: number;
      totalInquiries: number;
      activeListings: number;
      listings: Array<{ productId: string; viewCount: number; inquiryCount: number }>;
    }>(res);

    expect(body.totalViews).toBe(3);
    expect(body.totalInquiries).toBe(1);
    expect(body.activeListings).toBe(1);
    const listing = body.listings.find((item) => item.productId === productId);
    expect(listing?.viewCount).toBe(3);
    expect(listing?.inquiryCount).toBe(1);
  }, 15000);

  it("PASS/FAIL: My Shop's product list includes a real per-product view count", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const productId = await createProduct(artisan.token);

    await getSupabase().from("product_views").insert({ product_id: productId, viewer_role: "buyer" });
    await getSupabase().from("product_views").insert({ product_id: productId, viewer_role: "buyer" });

    const res = await fetch(`${base}/api/products`, { headers: auth(artisan.token) });
    const body = await json<Array<{ productId: string; viewCount: number }>>(res);

    const listed = body.find((item) => item.productId === productId);
    expect(listed?.viewCount).toBe(2);
  }, 15000);

  it("PASS/FAIL: an artisan's analytics never include another artisan's product", async () => {
    const EMAIL_OTHER = `analytics-other-${Date.now()}@example.com`;
    created.emails.push(EMAIL_OTHER);

    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const other = await signInAs(EMAIL_OTHER, "artisan");
    const ownProductId = await createProduct(artisan.token);
    const otherProductId = await createProduct(other.token);
    await getSupabase().from("product_views").insert({ product_id: otherProductId, viewer_role: "buyer" });

    const res = await fetch(`${base}/api/analytics/summary`, { headers: auth(artisan.token) });
    const body = await json<{ listings: Array<{ productId: string }> }>(res);

    expect(body.listings.some((item) => item.productId === ownProductId)).toBe(true);
    expect(body.listings.some((item) => item.productId === otherProductId)).toBe(false);
  }, 15000);
});
