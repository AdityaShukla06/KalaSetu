import { getSupabase } from "./supabase";

export class InvalidStorageUrlError extends Error {
  constructor() {
    super("URL does not point at this user's own storage folder");
    this.name = "InvalidStorageUrlError";
  }
}

export function resolveOwnStorageUrl(sourceUrl: string, bucket: string, uid: string): string {
  const expected = new URL(getSupabase().storage.from(bucket).getPublicUrl(`${uid}/`).data.publicUrl);

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new InvalidStorageUrlError();
  }

  if (parsed.origin !== expected.origin) throw new InvalidStorageUrlError();
  if (!parsed.pathname.startsWith(expected.pathname) || parsed.pathname.includes("..")) {
    throw new InvalidStorageUrlError();
  }

  return parsed.toString();
}
