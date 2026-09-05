import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `marketplace-artisan-${Date.now()}@example.com`;
const EMAIL_BUYER = `marketplace-buyer-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase().from("products").select("material, region, artisan_name").limit(1);
  schemaReady = !error;
  if (!schemaReady) {
    console.warn(
      "Skipping marketplace tests: this database predates the marketplace fields migration. " +
        "Run supabase/migrations/003-marketplace-fields.sql first.",
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
): Promise<string> {
  const res = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "pottery",
      material: "Clay",
      titleEn: "Marketplace Test Vase",
      titleLocal: "बाजार परीक्षण फूलदान",
      localLanguage: "hi",
      descriptionEn: "A distinctive test vase for marketplace search",
      descriptionLocal: "बाजार खोज के लिए एक विशिष्ट परीक्षण फूलदान",
      imageUrl: "https://example.com/marketplace-test.jpg",
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

suite("marketplace search", () => {
  it("PASS/FAIL: filters by category", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const potteryId = await createProduct(artisan.token, { category: "pottery" });
    const woodworkId = await createProduct(artisan.token, { category: "woodwork" });

    const res = await fetch(`${base}/api/products/marketplace?category=woodwork`, { headers: auth(buyer.token) });
    const body = await json<{ items: Array<{ productId: string }> }>(res);
    const ids = body.items.map((item) => item.productId);

    expect(ids).toContain(woodworkId);
    expect(ids).not.toContain(potteryId);
  });

  it("PASS/FAIL: filters by material and region together", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    await getSupabase().from("users").update({ region: "Rajasthan" }).eq("id", artisan.userId);

    const matchId = await createProduct(artisan.token, { material: "Brass" });
    const mismatchId = await createProduct(artisan.token, { material: "Cotton" });

    const res = await fetch(`${base}/api/products/marketplace?material=Brass&region=Rajasthan`, {
      headers: auth(buyer.token),
    });
    const body = await json<{ items: Array<{ productId: string }> }>(res);
    const ids = body.items.map((item) => item.productId);

    expect(ids).toContain(matchId);
    expect(ids).not.toContain(mismatchId);
  });

  it("PASS/FAIL: filters by price range", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const cheapId = await createProduct(artisan.token, { price: 50 });
    const expensiveId = await createProduct(artisan.token, { price: 5000 });

    const res = await fetch(`${base}/api/products/marketplace?minPrice=1000`, { headers: auth(buyer.token) });
    const body = await json<{ items: Array<{ productId: string }> }>(res);
    const ids = body.items.map((item) => item.productId);

    expect(ids).toContain(expensiveId);
    expect(ids).not.toContain(cheapId);
  });

  it("PASS/FAIL: free text search matches the title", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const stamp = Date.now();
    const matchId = await createProduct(artisan.token, { titleEn: `Unique Search Token ${stamp}` });

    const res = await fetch(`${base}/api/products/marketplace?q=${encodeURIComponent(`Search Token ${stamp}`)}`, {
      headers: auth(buyer.token),
    });
    const body = await json<{ items: Array<{ productId: string }> }>(res);

    expect(body.items.map((item) => item.productId)).toContain(matchId);
  });

  it("PASS/FAIL: sorts by price ascending and descending", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const stamp = Date.now();
    const q = `Sort Test ${stamp}`;
    const lowId = await createProduct(artisan.token, { titleEn: `${q} Low`, price: 111 });
    const highId = await createProduct(artisan.token, { titleEn: `${q} High`, price: 9999 });

    const asc = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/products/marketplace?q=${encodeURIComponent(q)}&sort=price_asc&limit=48`, {
        headers: auth(buyer.token),
      }),
    );
    const ascIds = asc.items.map((item) => item.productId);
    expect(ascIds.indexOf(lowId)).toBeLessThan(ascIds.indexOf(highId));

    const desc = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/products/marketplace?q=${encodeURIComponent(q)}&sort=price_desc&limit=48`, {
        headers: auth(buyer.token),
      }),
    );
    const descIds = desc.items.map((item) => item.productId);
    expect(descIds.indexOf(highId)).toBeLessThan(descIds.indexOf(lowId));
  });

  it("PASS/FAIL: paginates without duplicates or gaps", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const stamp = Date.now();
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await createProduct(artisan.token, { titleEn: `Pagination Test ${stamp} #${i}` }));
    }

    const q = `Pagination Test ${stamp}`;
    const page1 = await json<{ items: Array<{ productId: string }>; hasMore: boolean; total: number }>(
      await fetch(`${base}/api/products/marketplace?q=${encodeURIComponent(q)}&limit=2&page=1`, {
        headers: auth(buyer.token),
      }),
    );
    const page2 = await json<{ items: Array<{ productId: string }> }>(
      await fetch(`${base}/api/products/marketplace?q=${encodeURIComponent(q)}&limit=2&page=2`, {
        headers: auth(buyer.token),
      }),
    );

    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page2.items).toHaveLength(1);

    const allIds = [...page1.items, ...page2.items].map((item) => item.productId).sort();
    expect(allIds).toEqual([...ids].sort());
  });

  it("PASS/FAIL: product detail 404s for a draft product", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);
    await getSupabase().from("products").update({ status: "draft" }).eq("id", productId);

    const res = await fetch(`${base}/api/products/marketplace/${productId}`, { headers: auth(buyer.token) });
    expect(res.status).toBe(404);
  });

  it("PASS/FAIL: product detail includes a live artisan summary", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    await getSupabase().from("users").update({ shop_name: "Test Handicrafts Co" }).eq("id", artisan.userId);
    const productId = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/products/marketplace/${productId}`, { headers: auth(buyer.token) });
    const body = await json<{ artisan: { shopName: string | null; totalProducts: number } }>(res);

    expect(res.status).toBe(200);
    expect(body.artisan.shopName).toBe("Test Handicrafts Co");
    expect(typeof body.artisan.totalProducts).toBe("number");
  });
});
