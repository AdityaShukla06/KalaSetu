import { getFirebaseAuth } from "../firebase";

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

const TOKEN_KEY = "kalasetu.token";

async function getAuthToken(): Promise<string | null> {
  try {
    const user = getFirebaseAuth().currentUser;
    if (user) {
      const token = await user.getIdToken();
      localStorage.setItem(TOKEN_KEY, token);
      return token;
    }
  } catch {
    return localStorage.getItem(TOKEN_KEY);
  }
  return localStorage.getItem(TOKEN_KEY);
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(options.headers);

  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new Error(`${path} failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}
