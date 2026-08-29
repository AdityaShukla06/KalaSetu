import { apiFetch } from "./_helpers";

//types
export interface UserProfile {
  userId: string;
  phoneNumber: string;
  displayName: string | null;
  shopName: string | null;
  language: "en" | "hi";
  totalProducts: number;
  createdAt: string;
}

//user profile
export function getMyProfile(): Promise<UserProfile> {
  return apiFetch("/users/me", { method: "GET" });
}

//profile update
export function updateMyProfile(
  updates: Partial<Pick<UserProfile, "displayName" | "shopName" | "phoneNumber" | "language">>,
): Promise<{ success: boolean }> {
  return apiFetch("/users/me", {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}
