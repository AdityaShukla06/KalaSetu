import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { hashPassword } from "../server/lib/password";

const email = (process.argv[2] || "").trim().toLowerCase();
const password = process.argv[3] || "";

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
  console.error("Usage: npm run admin:set-password -- <email> <password>");
  console.error("The password must be at least 8 characters.");
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
  console.error(`No account found for ${email}. Promote or create the admin account first (npm run promote:admin or npm run seed:demo-admin).`);
  process.exit(1);
}

if (user.role !== "admin") {
  console.error(`${email} is a ${user.role} account, not an admin. Only admin accounts sign in with a password; run npm run promote:admin first.`);
  process.exit(1);
}

const { error: updateError } = await supabase
  .from("users")
  .update({ password_hash: hashPassword(password), failed_login_attempts: 0, locked_until: null })
  .eq("id", user.id);

if (updateError) {
  console.error(`Could not set the password for ${email}: ${updateError.message}`);
  process.exit(1);
}

console.log(`Password set for ${email}. They'll now be asked for this password instead of an emailed code on the sign-in screen.`);
