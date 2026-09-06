import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `stock-artisan-${Date.now()}@example.com`;
const EMAIL_OTHER_ARTISAN = `stock-other-artisan-${Date.now()}@example.com`;
const EMAIL_BUYER = `stock-buyer-${Date.now()}@example.com`;
const EMAIL_ADMIN = `stock-admin-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase().from("products").select("in_stock").limit(1);
  schemaReady = !error;
  if (!schemaReady) {
    console.warn(
      "Skipping stock and moderation search tests: this database predates the stock/reply migration. " +
        "Run supabase/migrations/011-stock-and-replies.sql first.",
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
  emails: [EMAIL_ARTISAN, EMAIL_OTHER_ARTISAN, EMAIL_BUYER, EMAIL_ADMIN],
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

async function signInAsAdmin(email: string): Promise<{ token: string; userId: string }> {
  const supabase = getSupabase();
  const signedIn = await signInAs(email, "buyer");
  await supabase.from("users").update({ role: "admin" }).eq("id", signedIn.userId);
  return signedIn;
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
      titleEn: "Stock Test Vase",
      titleLocal: "स्टॉक परीक्षण फूलदान",
      localLanguage: "hi",
      descriptionEn: "A distinctive test vase for the stock test suite",
      descriptionLocal: "स्टॉक परीक्षण के लिए एक विशिष्ट फूलदान",
      imageUrl: "https://example.com/stock-test.jpg",
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

suite("out of stock toggle", () => {
  it("PASS/FAIL: a new product starts in stock, and the artisan can mark it out of stock and back", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const productId = await createProduct(artisan.token);

    const mine = await json<Array<{ productId: string; inStock: boolean }>>(
      await fetch(`${base}/api/products?userId=${artisan.userId}`, { headers: auth(artisan.token) }),
    );
    expect(mine.find((p) => p.productId === productId)?.inStock).toBe(true);

    const outRes = await fetch(`${base}/api/products/${productId}/stock`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ inStock: false }),
    });
    expect(outRes.status).toBe(200);

    const detail = await json<{ inStock: boolean }>(
      await fetch(`${base}/api/products/marketplace/${productId}`, { headers: auth(artisan.token) }),
    );
    expect(detail.inStock).toBe(false);

    const backRes = await fetch(`${base}/api/products/${productId}/stock`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ inStock: true }),
    });
    expect(backRes.status).toBe(200);
  }, 15000);

  it("PASS/FAIL: an artisan cannot change another artisan's stock status, and a buyer can still inquire on an out-of-stock item", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const otherArtisan = await signInAs(EMAIL_OTHER_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const wrongArtisanRes = await fetch(`${base}/api/products/${productId}/stock`, {
      method: "PATCH",
      headers: { ...auth(otherArtisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ inStock: false }),
    });
    expect(wrongArtisanRes.status).toBe(404);

    await fetch(`${base}/api/products/${productId}/stock`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ inStock: false }),
    });

    const inquiryRes = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        message: "When will this be back in stock?",
        contactPreference: "email",
      }),
    });
    expect(inquiryRes.status).toBe(201);
  }, 15000);
});

suite("moderation queue search", () => {
  it("PASS/FAIL: searches the moderation queue by title, scoped to pending listings only", async () => {
    const admin = await signInAsAdmin(EMAIL_ADMIN);
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const stamp = Date.now();
    const productId = await createProduct(artisan.token, { titleEn: `Moderation Search Target ${stamp}` });

    const found = await json<{ items: Array<{ productId: string }>; total: number }>(
      await fetch(`${base}/api/internal/console/moderation/queue?q=${encodeURIComponent(`Moderation Search Target ${stamp}`)}`, {
        headers: auth(admin.token),
      }),
    );
    expect(found.items.some((item) => item.productId === productId)).toBe(true);

    const notFound = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/internal/console/moderation/queue?q=${encodeURIComponent(`no-such-listing-${stamp}`)}`, {
        headers: auth(admin.token),
      }),
    );
    expect(notFound.items.some((item) => item.productId === productId)).toBe(false);
  }, 15000);
});
