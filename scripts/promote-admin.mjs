import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const email = (process.argv[2] || "").trim().toLowerCase();

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: node scripts/promote-admin.mjs <email>");
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env to run this.");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: user, error: findError } = await supabase
  .from("users")
  .select("id, role")
  .eq("email", email)
  .maybeSingle();

if (findError) {
  console.error(`Could not look up ${email}: ${findError.message}`);
  process.exit(1);
}

if (!user) {
  console.error(
    `No account found for ${email}. They need to sign in at least once (request-otp / verify-otp) before you can promote them.`,
  );
  process.exit(1);
}

if (user.role === "admin") {
  console.log(`${email} is already an admin. Nothing to do.`);
  process.exit(0);
}

const { error: updateError } = await supabase.from("users").update({ role: "admin" }).eq("id", user.id);

if (updateError) {
  console.error(`Could not promote ${email}: ${updateError.message}`);
  process.exit(1);
}

console.log(`${email} is now an admin (was ${user.role}). They'll land in the admin console on their next sign in.`);
