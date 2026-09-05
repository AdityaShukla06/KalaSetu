import { getSupabase } from "./supabase";

export async function generatePassportId(date: Date = new Date()): Promise<string> {
  const year = date.getFullYear();

  const { data, error } = await getSupabase().rpc("next_passport_number", { target_year: year });
  if (error) {
    throw new Error(`Could not generate a passport id: ${error.message}`);
  }

  const sequence = String(data).padStart(6, "0");
  return `ART-${year}-${sequence}`;
}
