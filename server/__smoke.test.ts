import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import sharp from "sharp";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_A = `smoke-a-${Date.now()}@example.com`;
const EMAIL_B = `smoke-b-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.GEMINI_API_KEY,
);
const suite = HAS_CREDENTIALS ? describe : describe.skip;

const created: {
  users: string[];
  products: string[];
  emails: string[];
  storagePaths: string[];
} = {
  users: [],
  products: [],
  emails: [EMAIL_A, EMAIL_B],
  storagePaths: [],
};

function trackStoragePath(publicUrl: string): void {
  const marker = "/product-images/";
  const index = publicUrl.indexOf(marker);
  if (index >= 0) created.storagePaths.push(publicUrl.slice(index + marker.length));
}

async function signIn(email: string): Promise<{ token: string; userId: string }> {
  const req = await fetch(`${base}/api/auth/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(req.status).toBe(200);

  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, otp: FALLBACK }),
  });
  expect(res.status).toBe(200);

  const body = await json(res);
  created.users.push(body.userId);
  return body;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function json<T = any>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
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
  if (created.storagePaths.length) {
    await sb.storage.from("product-images").remove(created.storagePaths);
  }
  if (created.products.length) await sb.from("products").delete().in("id", created.products);
  if (created.users.length) await sb.from("users").delete().in("id", created.users);
  if (created.emails.length) await sb.from("otp_codes").delete().in("email", created.emails);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

suite("health", () => {
  it("answers without auth", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: "ok" });
  });

  it("404s an unknown route as JSON", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await json(res)).toHaveProperty("error");
  });
});

suite("auth", () => {
  it("rejects a bad email", async () => {
    const res = await fetch(`${base}/api/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  it("signs in with the demo fallback code and returns a usable token", async () => {
    const { token, userId } = await signIn(EMAIL_A);
    expect(token.split(".")).toHaveLength(3);
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a wrong code", async () => {
    await fetch(`${base}/api/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL_A }),
    });
    const res = await fetch(`${base}/api/auth/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL_A, otp: "0000" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns the same user id for the same email", async () => {
    const first = await signIn(EMAIL_A);
    const second = await signIn(EMAIL_A);
    expect(second.userId).toBe(first.userId);
  });
});

suite("protected routes", () => {
  it("401s without a token", async () => {
    for (const path of ["/api/users/me", "/api/products"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
    }
  });

  it("401s with a forged token", async () => {
    const res = await fetch(`${base}/api/users/me`, {
      headers: { Authorization: "Bearer not.a.token" },
    });
    expect(res.status).toBe(401);
  });
});

suite("full artisan journey", () => {
  it("runs photo, pricing, publish, edit and delete end to end", async () => {
    const { token, userId } = await signIn(EMAIL_A);

    const profileRes = await fetch(`${base}/api/users/me`, { headers: auth(token) });
    expect(profileRes.status).toBe(200);
    const profile = await json(profileRes);
    expect(profile).toMatchObject({ userId, email: EMAIL_A, totalProducts: 0 });

    const patchRes = await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Smoke Artisan", shopName: "Smoke Shop" }),
    });
    expect(patchRes.status).toBe(200);
    const reread = await json(await fetch(`${base}/api/users/me`, { headers: auth(token) }));
    expect(reread).toMatchObject({ displayName: "Smoke Artisan", shopName: "Smoke Shop" });

    const photo = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: { r: 150, g: 90, b: 40 } },
    })
      .png()
      .toBuffer();

    const enhanceRes = await fetch(`${base}/api/images/enhance`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/octet-stream", "X-File-Type": "image/png" },
      body: photo,
    });
    expect(enhanceRes.status).toBe(200);
    const { enhancedImageUrl, width } = await json(enhanceRes);
    trackStoragePath(enhancedImageUrl);
    expect(width).toBe(1600);
    expect(enhancedImageUrl).toContain("product-images");

    const fetched = await fetch(enhancedImageUrl);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toContain("image/jpeg");

    const priceRes = await fetch(`${base}/api/pricing/suggest`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "pottery",
        materialCost: 250,
        descriptionEn: "A tall ceramic vase for flowers",
        imageUrl: enhancedImageUrl,
      }),
    });
    expect(priceRes.status).toBe(200);
    const pricing = await json(priceRes);
    expect(pricing.suggestedMin).toBeLessThanOrEqual(pricing.suggestedMax);
    expect(pricing.reasoning).toBeTruthy();

    const createRes = await fetch(`${base}/api/products`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "pottery",
        titleEn: "Pottery",
        titleHi: "मिट्टी के बर्तन",
        descriptionEn: "A tall ceramic vase for flowers",
        descriptionHi: "फूलों के लिए एक लंबा मिट्टी का फूलदान",
        imageUrl: enhancedImageUrl,
        price: pricing.recommendedPrice,
        materialCost: 250,
      }),
    });
    expect(createRes.status).toBe(201);
    const { productId } = await json(createRes);
    created.products.push(productId);

    const listed = await json(await fetch(`${base}/api/products`, { headers: auth(token) }));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ productId, status: "published", userId });
    expect(typeof listed[0].createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(listed[0].createdAt))).toBe(false);

    const counted = await json(await fetch(`${base}/api/users/me`, { headers: auth(token) }));
    expect(counted.totalProducts).toBe(1);

    const editRes = await fetch(`${base}/api/products/${productId}`, {
      method: "PATCH",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ price: 1234, descriptionEn: "Edited description" }),
    });
    expect(editRes.status).toBe(200);
    const afterEdit = await json(await fetch(`${base}/api/products`, { headers: auth(token) }));
    expect(afterEdit[0]).toMatchObject({ price: 1234, descriptionEn: "Edited description" });

    const delRes = await fetch(`${base}/api/products/${productId}`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect(delRes.status).toBe(200);
    created.products = created.products.filter((id) => id !== productId);

    const emptied = await json(await fetch(`${base}/api/products`, { headers: auth(token) }));
    expect(emptied).toHaveLength(0);

    const decremented = await json(await fetch(`${base}/api/users/me`, { headers: auth(token) }));
    expect(decremented.totalProducts).toBe(0);
  });
});

suite("ownership isolation", () => {
  it("stops one artisan touching another artisan's product", async () => {
    const a = await signIn(EMAIL_A);
    const b = await signIn(EMAIL_B);

    const createRes = await fetch(`${base}/api/products`, {
      method: "POST",
      headers: { ...auth(a.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "pottery",
        titleEn: "Pottery",
        titleHi: "मिट्टी",
        descriptionEn: "Owned by A",
        descriptionHi: "A का",
        imageUrl: "https://example.com/a.jpg",
        price: 100,
        materialCost: 25,
      }),
    });
    const { productId } = await json(createRes);
    created.products.push(productId);

    const bList = await json(await fetch(`${base}/api/products`, { headers: auth(b.token) }));
    expect(bList.find((p: { productId: string }) => p.productId === productId)).toBeUndefined();

    const bEdit = await fetch(`${base}/api/products/${productId}`, {
      method: "PATCH",
      headers: { ...auth(b.token), "Content-Type": "application/json" },
      body: JSON.stringify({ price: 1 }),
    });
    expect(bEdit.status).toBe(404);

    const bDelete = await fetch(`${base}/api/products/${productId}`, {
      method: "DELETE",
      headers: auth(b.token),
    });
    expect(bDelete.status).toBe(404);

    const stillThere = await json(await fetch(`${base}/api/products`, { headers: auth(a.token) }));
    expect(stillThere.find((p: { productId: string }) => p.productId === productId)).toBeTruthy();

    const bQuery = await fetch(`${base}/api/products?userId=${a.userId}`, { headers: auth(b.token) });
    expect(bQuery.status).toBe(403);
  });
});

suite("upload guards", () => {
  it("rejects a non image body", async () => {
    const { token } = await signIn(EMAIL_A);
    const res = await fetch(`${base}/api/images/enhance`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/octet-stream", "X-File-Type": "image/png" },
      body: Buffer.from("definitely not an image"),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unsupported_image");
  });

  it("rejects an empty body", async () => {
    const { token } = await signIn(EMAIL_A);
    const res = await fetch(`${base}/api/images/enhance`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/octet-stream", "X-File-Type": "image/png" },
      body: Buffer.alloc(0),
    });
    expect(res.status).toBe(400);
  });

  it("requires a category on transcribe", async () => {
    const { token } = await signIn(EMAIL_A);
    const res = await fetch(`${base}/api/voice/transcribe`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/octet-stream", "X-File-Type": "audio/wav" },
      body: Buffer.from("fake"),
    });
    expect(res.status).toBe(400);
  });

  it("rejects webm audio the model cannot read, before calling the provider", async () => {
    const { token } = await signIn(EMAIL_A);
    const res = await fetch(`${base}/api/voice/transcribe?category=pottery`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/octet-stream", "X-File-Type": "audio/webm" },
      body: Buffer.from("fake audio bytes"),
    });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.stage).toBe("stt");
    expect(body.message).toMatch(/not supported/i);
  });
});
