import "dotenv/config";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY || !SUPABASE_JWT_SECRET) {
  console.error(
    "verify-rls needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET in .env.\n" +
      "The last two are only for this script (Dashboard -> Project Settings -> API) and are never read by the server.",
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function clientAs(userId) {
  const token = jwt.sign({ sub: userId, role: "authenticated" }, SUPABASE_JWT_SECRET, { expiresIn: "5m" });
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

const results = [];

async function check(name, fn) {
  try {
    const outcome = await fn();
    results.push({ name, pass: outcome === true, detail: outcome === true ? "" : String(outcome) });
  } catch (err) {
    results.push({ name, pass: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

async function seedUser(email, role) {
  const { data, error } = await admin.from("users").insert({ email, role }).select("id").single();
  if (error) throw new Error(`Could not seed ${role} user: ${error.message}`);
  return data.id;
}

async function seedProduct(userId, overrides = {}) {
  const { data, error } = await admin
    .from("products")
    .insert({
      user_id: userId,
      category: "pottery",
      title_en: "Pottery",
      title_local: "मिट्टी",
      description_en: "RLS verification product",
      description_local: "आरएलएस सत्यापन उत्पाद",
      local_language: "hi",
      image_url: "https://example.com/rls-test.jpg",
      price: 500,
      material_cost: 100,
      status: "published",
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not seed product: ${error.message}`);
  return data.id;
}

const stamp = Date.now();
const seeded = { userIds: [], productIds: [] };

async function main() {
  const artisanAId = await seedUser(`rls-artisan-a-${stamp}@example.com`, "artisan");
  const artisanBId = await seedUser(`rls-artisan-b-${stamp}@example.com`, "artisan");
  const buyerId = await seedUser(`rls-buyer-${stamp}@example.com`, "buyer");
  const adminId = await seedUser(`rls-admin-${stamp}@example.com`, "admin");
  seeded.userIds.push(artisanAId, artisanBId, buyerId, adminId);

  const productAId = await seedProduct(artisanAId, { status: "published" });
  const productBId = await seedProduct(artisanBId, { status: "published" });
  seeded.productIds.push(productAId, productBId);

  const asArtisanA = clientAs(artisanAId);
  const asBuyer = clientAs(buyerId);
  const asAdmin = clientAs(adminId);

  await check("artisan cannot read another artisan's product row", async () => {
    const { data } = await asArtisanA.from("products").select("id").eq("id", productBId);
    return (data ?? []).length === 0 || `saw ${data?.length} row(s), expected 0`;
  });

  await check("artisan cannot update their own role column", async () => {
    const { error } = await asArtisanA.from("users").update({ role: "admin" }).eq("id", artisanAId);
    if (!error) return "update succeeded, expected a permission error";
    const { data: reread } = await admin.from("users").select("role").eq("id", artisanAId).single();
    return reread?.role === "artisan" || `role became ${reread?.role}`;
  });

  await check("buyer cannot insert a product", async () => {
    const { error } = await asBuyer.from("products").insert({
      user_id: buyerId,
      category: "pottery",
      title_en: "Pottery",
      title_local: "मिट्टी",
      description_en: "Buyer attempt",
      description_local: "खरीदार प्रयास",
      local_language: "hi",
      image_url: "https://example.com/buyer.jpg",
      price: 500,
      material_cost: 100,
    });
    return Boolean(error) || "insert succeeded, expected it to be denied";
  });

  await check("buyer cannot update a product", async () => {
    const { data, error } = await asBuyer.from("products").update({ price: 1 }).eq("id", productAId).select("id");
    if (error) return true;
    return (data ?? []).length === 0 || "update affected a row, expected 0";
  });

  await check("buyer can read a published product", async () => {
    const { data } = await asBuyer.from("products").select("id").eq("id", productAId);
    return (data ?? []).length === 1 || `saw ${data?.length} row(s), expected 1`;
  });

  await check("admin can read all products", async () => {
    const { data } = await asAdmin.from("products").select("id").in("id", [productAId, productBId]);
    return (data ?? []).length === 2 || `saw ${data?.length} row(s), expected 2`;
  });

  await check("admin can update a moderation field", async () => {
    const { data, error } = await asAdmin
      .from("products")
      .update({ flagged: true, flag_reason: "rls verification" })
      .eq("id", productBId)
      .select("flagged, flag_reason");
    if (error) return error.message;
    const row = data?.[0];
    return (row?.flagged === true && row?.flag_reason === "rls verification") || `got ${JSON.stringify(row)}`;
  });

  console.log("\nRLS verification results\n");
  for (const result of results) {
    const label = result.pass ? "PASS" : "FAIL";
    console.log(`[${label}] ${result.name}${result.detail ? ` -- ${result.detail}` : ""}`);
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  await admin.from("products").delete().in("id", seeded.productIds);
  await admin.from("users").delete().in("id", seeded.userIds);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("verify-rls crashed:", err);
  if (seeded.productIds.length) await admin.from("products").delete().in("id", seeded.productIds);
  if (seeded.userIds.length) await admin.from("users").delete().in("id", seeded.userIds);
  process.exit(1);
});
