import { apiFetch } from "./_helpers";

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string | null;
  shopName: string | null;
  language: "en" | "hi";
  totalProducts: number;
  createdAt: string;
}

export function getMyProfile(): Promise<UserProfile> {
  return apiFetch("/users/me", { method: "GET" });
}

export function updateMyProfile(
  updates: Partial<Pick<UserProfile, "displayName" | "shopName" | "language">>,
): Promise<{ success: boolean }> {
  return apiFetch("/users/me", {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}
