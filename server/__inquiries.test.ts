import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import app from "./app";
import { getSupabase } from "./lib/supabase";

let server: Server;
let base: string;

const EMAIL_ARTISAN = `inquiry-artisan-${Date.now()}@example.com`;
const EMAIL_BUYER = `inquiry-buyer-${Date.now()}@example.com`;
const EMAIL_OTHER_ARTISAN = `inquiry-other-artisan-${Date.now()}@example.com`;
const FALLBACK = process.env.DEMO_FALLBACK_OTP || "5741";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let schemaReady = false;

beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  const [inquiriesCheck, usersCheck, replyCheck] = await Promise.all([
    getSupabase().from("inquiries").select("quantity, contact_preference, contact_value, read_at, responded_at, notified_at").limit(1),
    getSupabase().from("users").select("whatsapp_number").limit(1),
    getSupabase().from("inquiries").select("reply_message").limit(1),
  ]);
  schemaReady = !inquiriesCheck.error && !usersCheck.error && !replyCheck.error;
  if (!schemaReady) {
    console.warn(
      "Skipping inquiry flow tests: this database predates the inquiry details / WhatsApp or reply migration. " +
        "Run supabase/migrations/008-inquiry-details-and-whatsapp.sql and 011-stock-and-replies.sql first.",
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
  emails: [EMAIL_ARTISAN, EMAIL_BUYER, EMAIL_OTHER_ARTISAN],
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
      titleEn: "Inquiry Test Vase",
      titleLocal: "पूछताछ परीक्षण फूलदान",
      localLanguage: "hi",
      descriptionEn: "A distinctive test vase for the inquiry test suite",
      descriptionLocal: "पूछताछ परीक्षण के लिए एक विशिष्ट फूलदान",
      imageUrl: "https://example.com/inquiry-test.jpg",
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

suite("buyer-to-artisan inquiry flow", () => {
  it("PASS/FAIL: creates an inquiry with quantity and contact preference, and never loses the record even when email delivery is unavailable", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        message: "Do you have this in a larger size?",
        quantity: 3,
        contactPreference: "email",
      }),
    });
    const body = await json<{ inquiryId: string; emailDelivered: boolean }>(res);

    expect(res.status).toBe(201);
    expect(typeof body.emailDelivered).toBe("boolean");

    const { data } = await getSupabase()
      .from("inquiries")
      .select("quantity, contact_preference, message")
      .eq("id", body.inquiryId)
      .single();

    expect(data?.quantity).toBe(3);
    expect(data?.contact_preference).toBe("email");
    expect(data?.message).toBe("Do you have this in a larger size?");
  }, 15000);

  it("PASS/FAIL: requires a contact value when the preference is phone or whatsapp", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Interested", contactPreference: "whatsapp" }),
    });

    expect(res.status).toBe(400);
  }, 15000);

  it("PASS/FAIL: accepts a whatsapp contact preference with a contact value", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        message: "Interested",
        contactPreference: "whatsapp",
        contactValue: "+91 98765 43210",
      }),
    });

    expect(res.status).toBe(201);
  }, 15000);

  it("PASS/FAIL: only a buyer can create an inquiry", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const productId = await createProduct(artisan.token);

    const res = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Interested", contactPreference: "email" }),
    });

    expect(res.status).toBe(403);
  }, 15000);

  it("PASS/FAIL: the artisan sees a new inquiry as unread on first view, then read on the next view", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const createRes = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Interested", contactPreference: "email" }),
    });
    const { inquiryId } = await json<{ inquiryId: string }>(createRes);

    const firstView = await json<Array<{ inquiryId: string; readAt: string | null }>>(
      await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }),
    );
    const firstEntry = firstView.find((item) => item.inquiryId === inquiryId);
    expect(firstEntry?.readAt).toBeNull();

    const secondView = await json<Array<{ inquiryId: string; readAt: string | null }>>(
      await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }),
    );
    const secondEntry = secondView.find((item) => item.inquiryId === inquiryId);
    expect(secondEntry?.readAt).not.toBeNull();
  }, 15000);

  it("PASS/FAIL: the artisan can mark an inquiry as responded, and the buyer sees that reflected", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const createRes = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Interested", contactPreference: "email" }),
    });
    const { inquiryId } = await json<{ inquiryId: string }>(createRes);

    const respondRes = await fetch(`${base}/api/inquiries/${inquiryId}/responded`, {
      method: "PATCH",
      headers: auth(artisan.token),
    });
    expect(respondRes.status).toBe(200);

    const mine = await json<Array<{ inquiryId: string; respondedAt: string | null }>>(
      await fetch(`${base}/api/inquiries/mine`, { headers: auth(buyer.token) }),
    );
    const entry = mine.find((item) => item.inquiryId === inquiryId);
    expect(entry?.respondedAt).not.toBeNull();
  }, 15000);

  it("PASS/FAIL: the artisan can send a reply, and the buyer sees the reply text on their own inquiry", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const createRes = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Is this in stock?", contactPreference: "email" }),
    });
    const { inquiryId } = await json<{ inquiryId: string }>(createRes);

    const replyRes = await fetch(`${base}/api/inquiries/${inquiryId}/reply`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Yes, it's ready to ship." }),
    });
    expect(replyRes.status).toBe(200);
    const replyBody = await json<{ success: boolean; emailDelivered: boolean }>(replyRes);
    expect(replyBody.success).toBe(true);

    const mine = await json<Array<{ inquiryId: string; replyMessage: string | null; respondedAt: string | null }>>(
      await fetch(`${base}/api/inquiries/mine`, { headers: auth(buyer.token) }),
    );
    const entry = mine.find((item) => item.inquiryId === inquiryId);
    expect(entry?.replyMessage).toBe("Yes, it's ready to ship.");
    expect(entry?.respondedAt).not.toBeNull();
  }, 15000);

  it("PASS/FAIL: a reply cannot be empty, and an artisan cannot reply to another artisan's inquiry", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const otherArtisan = await signInAs(EMAIL_OTHER_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const createRes = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Interested", contactPreference: "email" }),
    });
    const { inquiryId } = await json<{ inquiryId: string }>(createRes);

    const emptyRes = await fetch(`${base}/api/inquiries/${inquiryId}/reply`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(emptyRes.status).toBe(400);

    const wrongArtisanRes = await fetch(`${base}/api/inquiries/${inquiryId}/reply`, {
      method: "PATCH",
      headers: { ...auth(otherArtisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Trying to reply to someone else's inquiry" }),
    });
    expect(wrongArtisanRes.status).toBe(404);

    const buyerReplyRes = await fetch(`${base}/api/inquiries/${inquiryId}/reply`, {
      method: "PATCH",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "A buyer should not be able to reply" }),
    });
    expect(buyerReplyRes.status).toBe(403);
  }, 15000);

  it("PASS/FAIL: an artisan cannot mark another artisan's inquiry as responded", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const otherArtisan = await signInAs(EMAIL_OTHER_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);

    const createRes = await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId, message: "Interested", contactPreference: "email" }),
    });
    const { inquiryId } = await json<{ inquiryId: string }>(createRes);

    const res = await fetch(`${base}/api/inquiries/${inquiryId}/responded`, {
      method: "PATCH",
      headers: auth(otherArtisan.token),
    });

    expect(res.status).toBe(404);
  }, 15000);

  it("PASS/FAIL: only an artisan can list received inquiries", async () => {
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const res = await fetch(`${base}/api/inquiries/received`, { headers: auth(buyer.token) });
    expect(res.status).toBe(403);
  }, 15000);

  it("PASS/FAIL: an artisan only receives inquiries about their own products", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const otherArtisan = await signInAs(EMAIL_OTHER_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const ownProductId = await createProduct(artisan.token);
    const otherProductId = await createProduct(otherArtisan.token);

    await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId: ownProductId, message: "For artisan A", contactPreference: "email" }),
    });
    await fetch(`${base}/api/inquiries`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId: otherProductId, message: "For artisan B", contactPreference: "email" }),
    });

    const received = await json<Array<{ productId: string }>>(
      await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }),
    );

    expect(received.some((item) => item.productId === ownProductId)).toBe(true);
    expect(received.some((item) => item.productId === otherProductId)).toBe(false);
  }, 15000);

  it("PASS/FAIL: an artisan can set and clear an optional WhatsApp number on their profile", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");

    const setRes = await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ whatsappNumber: "+91 98765 43210" }),
    });
    expect(setRes.status).toBe(200);

    const profile = await json<{ whatsappNumber: string | null }>(
      await fetch(`${base}/api/users/me`, { headers: auth(artisan.token) }),
    );
    expect(profile.whatsappNumber).toBe("+91 98765 43210");

    await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ whatsappNumber: "" }),
    });

    const cleared = await json<{ whatsappNumber: string | null }>(
      await fetch(`${base}/api/users/me`, { headers: auth(artisan.token) }),
    );
    expect(cleared.whatsappNumber).toBeNull();
  }, 15000);

  it("PASS/FAIL: the marketplace product detail exposes the artisan's WhatsApp number to buyers", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    await fetch(`${base}/api/users/me`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ whatsappNumber: "+91 98765 43210" }),
    });
    const productId = await createProduct(artisan.token);

    const body = await json<{ artisan: { whatsappNumber: string | null } }>(
      await fetch(`${base}/api/products/marketplace/${productId}`, { headers: auth(buyer.token) }),
    );

    expect(body.artisan.whatsappNumber).toBe("+91 98765 43210");
  }, 15000);
});
