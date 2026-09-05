import "dotenv/config";
import { describe, it, expect } from "vitest";
import { resolveOwnStorageUrl, InvalidStorageUrlError } from "./ownStorageUrl";
import { getSupabase } from "./supabase";

const HAS_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const suite = HAS_CREDENTIALS ? describe : describe.skip;
const BUCKET = "product-images";
const UID = "user-a";

function ownUrl(path: string): string {
  return getSupabase().storage.from(BUCKET).getPublicUrl(`${UID}/${path}`).data.publicUrl;
}

suite("resolveOwnStorageUrl", () => {
  it("accepts a URL under the caller's own folder", () => {
    const url = ownUrl("cutout/photo.png");
    expect(resolveOwnStorageUrl(url, BUCKET, UID)).toBe(url);
  });

  it("rejects a URL under a different user's folder", () => {
    const url = getSupabase().storage.from(BUCKET).getPublicUrl("user-b/cutout/photo.png").data.publicUrl;
    expect(() => resolveOwnStorageUrl(url, BUCKET, UID)).toThrow(InvalidStorageUrlError);
  });

  it("rejects a URL on a different host entirely", () => {
    expect(() => resolveOwnStorageUrl("https://evil.example.com/anything", BUCKET, UID)).toThrow(
      InvalidStorageUrlError,
    );
  });

  it("rejects a path traversal attempt that normalises outside the caller's folder", () => {
    const own = new URL(ownUrl("cutout/photo.png"));
    const traversal = `${own.origin}${own.pathname.replace("cutout/photo.png", "../user-b/cutout/photo.png")}`;
    expect(() => resolveOwnStorageUrl(traversal, BUCKET, UID)).toThrow(InvalidStorageUrlError);
  });

  it("rejects a string that is not a URL at all", () => {
    expect(() => resolveOwnStorageUrl("not a url", BUCKET, UID)).toThrow(InvalidStorageUrlError);
  });
});
