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
  const [inquiriesCheck, usersCheck, messagesCheck] = await Promise.all([
    getSupabase().from("inquiries").select("quantity, contact_preference, contact_value, artisan_last_read_at, buyer_last_read_at").limit(1),
    getSupabase().from("users").select("whatsapp_number").limit(1),
    getSupabase().from("inquiry_messages").select("id").limit(1),
  ]);
  schemaReady = !inquiriesCheck.error && !usersCheck.error && !messagesCheck.error;
  if (!schemaReady) {
    console.warn(
      "Skipping inquiry flow tests: this database predates the inquiry threads migration. " +
        "Run supabase/migrations/008-inquiry-details-and-whatsapp.sql and 014-inquiry-threads.sql first.",
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

interface InquiryMessageJson {
  messageId: string;
  senderRole: "buyer" | "artisan";
  body: string;
  createdAt: string;
}

interface InquiryJson {
  inquiryId: string;
  productId: string;
  status: "open" | "closed";
  messages: InquiryMessageJson[];
  isUnread: boolean;
}

async function createInquiry(
  buyerToken: string,
  productId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await fetch(`${base}/api/inquiries`, {
    method: "POST",
    headers: { ...auth(buyerToken), "Content-Type": "application/json" },
    body: JSON.stringify({ productId, message: "Interested", contactPreference: "email", ...overrides }),
  });
  const body = await json<{ inquiryId: string }>(res);
  if (res.status !== 201) throw new Error(`Could not create test inquiry: ${JSON.stringify(body)}`);
  return body.inquiryId;
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

suite("buyer-to-artisan inquiry threads", () => {
  it("PASS/FAIL: creates an inquiry with a first message, quantity, and contact preference, and never loses the record even when email delivery is unavailable", async () => {
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

    const { data } = await getSupabase().from("inquiries").select("quantity, contact_preference").eq("id", body.inquiryId).single();
    expect(data?.quantity).toBe(3);
    expect(data?.contact_preference).toBe("email");

    const { data: messages } = await getSupabase()
      .from("inquiry_messages")
      .select("sender_role, body")
      .eq("inquiry_id", body.inquiryId);
    expect(messages).toHaveLength(1);
    expect(messages?.[0].sender_role).toBe("buyer");
    expect(messages?.[0].body).toBe("Do you have this in a larger size?");
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
    const inquiryId = await createInquiry(buyer.token, productId);

    const firstView = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }));
    expect(firstView.find((item) => item.inquiryId === inquiryId)?.isUnread).toBe(true);

    const secondView = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }));
    expect(secondView.find((item) => item.inquiryId === inquiryId)?.isUnread).toBe(false);
  }, 15000);

  it("PASS/FAIL: a real back-and-forth: artisan replies, buyer replies again, artisan replies again, all visible to both sides in order", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);
    const inquiryId = await createInquiry(buyer.token, productId, { message: "Is this in stock?" });

    const reply1 = await fetch(`${base}/api/inquiries/${inquiryId}/messages`, {
      method: "POST",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Yes, it's ready to ship." }),
    });
    expect(reply1.status).toBe(201);
    const reply1Body = await json<{ messageId: string; emailDelivered: boolean }>(reply1);
    expect(typeof reply1Body.emailDelivered).toBe("boolean");

    const followUp = await fetch(`${base}/api/inquiries/${inquiryId}/messages`, {
      method: "POST",
      headers: { ...auth(buyer.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Great, can you do it in blue?" }),
    });
    expect(followUp.status).toBe(201);

    const reply2 = await fetch(`${base}/api/inquiries/${inquiryId}/messages`, {
      method: "POST",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Sure, that works." }),
    });
    expect(reply2.status).toBe(201);

    const buyerView = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/mine`, { headers: auth(buyer.token) }));
    const buyerEntry = buyerView.find((item) => item.inquiryId === inquiryId);
    expect(buyerEntry?.messages.map((m) => [m.senderRole, m.body])).toEqual([
      ["buyer", "Is this in stock?"],
      ["artisan", "Yes, it's ready to ship."],
      ["buyer", "Great, can you do it in blue?"],
      ["artisan", "Sure, that works."],
    ]);

    const artisanView = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }));
    const artisanEntry = artisanView.find((item) => item.inquiryId === inquiryId);
    expect(artisanEntry?.messages).toHaveLength(4);
  }, 20000);

  it("PASS/FAIL: unread tracking works independently for each side of the conversation", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);
    const inquiryId = await createInquiry(buyer.token, productId);

    await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) });

    await fetch(`${base}/api/inquiries/${inquiryId}/messages`, {
      method: "POST",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Replying now" }),
    });

    const buyerView = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/mine`, { headers: auth(buyer.token) }));
    expect(buyerView.find((item) => item.inquiryId === inquiryId)?.isUnread).toBe(true);

    const artisanView = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }));
    expect(artisanView.find((item) => item.inquiryId === inquiryId)?.isUnread).toBe(false);
  }, 20000);

  it("PASS/FAIL: a message cannot be empty, and only the buyer or artisan on the inquiry can send one", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const otherArtisan = await signInAs(EMAIL_OTHER_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);
    const inquiryId = await createInquiry(buyer.token, productId);

    const emptyRes = await fetch(`${base}/api/inquiries/${inquiryId}/messages`, {
      method: "POST",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "" }),
    });
    expect(emptyRes.status).toBe(400);

    const wrongPartyRes = await fetch(`${base}/api/inquiries/${inquiryId}/messages`, {
      method: "POST",
      headers: { ...auth(otherArtisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Trying to message someone else's inquiry" }),
    });
    expect(wrongPartyRes.status).toBe(404);
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

    await createInquiry(buyer.token, ownProductId, { message: "For artisan A" });
    await createInquiry(buyer.token, otherProductId, { message: "For artisan B" });

    const received = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/received`, { headers: auth(artisan.token) }));

    expect(received.some((item) => item.productId === ownProductId)).toBe(true);
    expect(received.some((item) => item.productId === otherProductId)).toBe(false);
  }, 15000);

  it("PASS/FAIL: either party can close an inquiry", async () => {
    const artisan = await signInAs(EMAIL_ARTISAN, "artisan");
    const buyer = await signInAs(EMAIL_BUYER, "buyer");
    const productId = await createProduct(artisan.token);
    const inquiryId = await createInquiry(buyer.token, productId);

    const res = await fetch(`${base}/api/inquiries/${inquiryId}`, {
      method: "PATCH",
      headers: { ...auth(artisan.token), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(res.status).toBe(200);

    const buyerView = await json<InquiryJson[]>(await fetch(`${base}/api/inquiries/mine`, { headers: auth(buyer.token) }));
    expect(buyerView.find((item) => item.inquiryId === inquiryId)?.status).toBe("closed");
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
