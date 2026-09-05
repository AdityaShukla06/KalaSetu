import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `passport-artisan-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const { error } = await getSupabase()
    .from("products")
    .select("passport_id, technique, time_taken, gi_tag, care_instructions, product_story, story_generated_at")
    .limit(1);
  schemaReady = !error;
  if (!schemaReady) {
    console.warn(
      "Skipping passport tests: this database predates the heritage passport migration. " +
        "Run supabase/migrations/005-heritage-passport.sql first.",
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
  emails: [EMAIL_ARTISAN],
};

async function signInAsArtisan(): Promise<{ token: string; userId: string }> {
  await fetch(`${base}/api/auth/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL_ARTISAN }),
  });

  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL_ARTISAN, otp: FALLBACK, intendedRole: "artisan" }),
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
): Promise<{ productId: string; passportId: string }> {
  const res = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "pottery",
      material: "Clay",
      titleEn: "Passport Test Vase",
      titleLocal: "पासपोर्ट परीक्षण फूलदान",
      localLanguage: "hi",
      descriptionEn: "A distinctive test vase made for the passport test suite",
      descriptionLocal: "पासपोर्ट परीक्षण के लिए एक विशिष्ट फूलदान",
      imageUrl: "https://example.com/passport-test.jpg",
      price: 500,
      materialCost: 100,
      ...overrides,
    }),
  });
  const body = await json<{ productId: string; passportId: string }>(res);
  created.products.push(body.productId);
  return body;
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

suite("heritage passport", () => {
  it("PASS/FAIL: assigns a sequential ART-YYYY-NNNNNN passport id on creation", async () => {
    const artisan = await signInAsArtisan();
    const { passportId } = await createProduct(artisan.token);

    expect(passportId).toMatch(/^ART-\d{4}-\d{6}$/);
  });

  it("PASS/FAIL: public passport endpoint exposes only the intended fields for a published product", async () => {
    const artisan = await signInAsArtisan();
    const { passportId } = await createProduct(artisan.token, {
      technique: "Hand-thrown on a potter's wheel",
      timeTaken: "3 days",
      giTag: "",
      careInstructions: "Wipe with a dry cloth",
    });

    const res = await fetch(`${base}/api/passport/${passportId}`);
    const body = await json<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.passportId).toBe(passportId);
    expect(body.technique).toBe("Hand-thrown on a potter's wheel");
    expect(body.timeTaken).toBe("3 days");
    expect(body.careInstructions).toBe("Wipe with a dry cloth");
    expect(body).not.toHaveProperty("price");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("reviewStatus");
  });

  it("PASS/FAIL: generates a stable product story from provided fields only", async () => {
    const artisan = await signInAsArtisan();
    const { passportId } = await createProduct(artisan.token, {
      technique: "Hand-thrown on a potter's wheel",
    });

    const first = await json<{ productStory: string | null }>(
      await fetch(`${base}/api/passport/${passportId}`),
    );
    const second = await json<{ productStory: string | null }>(
      await fetch(`${base}/api/passport/${passportId}`),
    );

    expect(first.productStory).toBe(second.productStory);
  }, 20000);

  it("PASS/FAIL: 404s for a draft product's passport", async () => {
    const artisan = await signInAsArtisan();
    const { passportId, productId } = await createProduct(artisan.token);
    await getSupabase().from("products").update({ status: "draft" }).eq("id", productId);

    const res = await fetch(`${base}/api/passport/${passportId}`);
    expect(res.status).toBe(404);
  });

  it("PASS/FAIL: 404s for a flagged product's passport", async () => {
    const artisan = await signInAsArtisan();
    const { passportId, productId } = await createProduct(artisan.token);
    await getSupabase().from("products").update({ flagged: true }).eq("id", productId);

    const res = await fetch(`${base}/api/passport/${passportId}`);
    expect(res.status).toBe(404);
  });

  it("PASS/FAIL: 404s for a passport id that does not exist", async () => {
    const res = await fetch(`${base}/api/passport/ART-1999-999999`);
    expect(res.status).toBe(404);
  });

  it("PASS/FAIL: passport is reachable with no auth header at all", async () => {
    const artisan = await signInAsArtisan();
    const { passportId } = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/passport/${passportId}`);
    expect(res.status).toBe(200);
  });
});
