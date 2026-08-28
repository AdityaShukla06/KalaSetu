export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

//func to validate request from authorized user
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("kalasetu.token");
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
