export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";

const TOKEN_KEY = "kalasetu.token";

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(options.headers);

  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (
    options.body &&
    typeof options.body === "string" &&
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

export async function apiUpload<T>(
  path: string,
  blob: Blob,
  fileType: string,
): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers();

  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("X-File-Type", fileType);

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    body: blob,
    headers,
  });

  if (!response.ok) {
    throw new Error(`${path} failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}
