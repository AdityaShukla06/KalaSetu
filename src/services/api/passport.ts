import { apiFetch } from "./_helpers";

export interface PublicPassport {
  passportId: string;
  titleEn: string;
  titleLocal: string;
  localLanguage: string;
  category: string;
  technique: string | null;
  material: string | null;
  timeTaken: string | null;
  giTag: string | null;
  careInstructions: string | null;
  imageUrl: string;
  artisanName: string | null;
  region: string | null;
  createdAt: string;
  productStory: string | null;
}

export function getPublicPassport(passportId: string): Promise<PublicPassport> {
  return apiFetch(`/passport/${encodeURIComponent(passportId)}`, { method: "GET" });
}
