import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "./env";

let cached: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const env = loadEnv();
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}

export function getStorageBucket(): string {
  return loadEnv().SUPABASE_STORAGE_BUCKET;
}
