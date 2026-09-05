import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_EMAIL = "admin@kalasetu.demo";
const email = (process.argv[2] || DEFAULT_EMAIL).trim().toLowerCase();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: node scripts/seed-demo-admin.mjs [email]");
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env to run this.");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: existing, error: findError } = await supabase
  .from("users")
  .select("id, role, is_active")
  .eq("email", email)
  .maybeSingle();

if (findError) {
  console.error(`Could not look up ${email}: ${findError.message}`);
  process.exit(1);
}

if (existing) {
  if (existing.role === "admin" && existing.is_active) {
    console.log(`${email} already exists as an active admin. Nothing to do.`);
  } else {
    const { error: updateError } = await supabase
      .from("users")
      .update({ role: "admin", is_active: true })
      .eq("id", existing.id);
    if (updateError) {
      console.error(`Could not update ${email}: ${updateError.message}`);
      process.exit(1);
    }
    console.log(`${email} already existed (role was ${existing.role}); set to an active admin.`);
  }
} else {
  const { error: insertError } = await supabase.from("users").insert({
    email,
    display_name: "Demo Admin",
    role: "admin",
    is_active: true,
  });
  if (insertError) {
    console.error(`Could not create ${email}: ${insertError.message}`);
    process.exit(1);
  }
  console.log(`Created ${email} as a new admin account.`);
}

console.log(
  `\nTo sign in: open the app, enter "${email}" on the email screen (either role choice is fine, it's ignored for an existing account), and verify with the demo code (default 5741, see DEMO_FALLBACK_OTP in .env) unless you've turned that off.`,
);
