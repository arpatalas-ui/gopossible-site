// Tiny API client. Backend URL comes from .env – never hardcode.
const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

if (!BASE) {
  // Fail fast so devs see the issue.
  console.warn("EXPO_PUBLIC_BACKEND_URL is not set");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.detail || JSON.stringify(j);
    } catch {
      detail = await res.text();
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type Stop = {
  id: string;
  order: number;
  address: string;
  recipient_name: string;
  phone: string;
  package_numbers: string[];
  cod_amount: number;
  status: "pending" | "delivered" | "absent";
  photo_base64?: string | null;
  signature_base64?: string | null;
  note?: string | null;
  completed_at?: string | null;
};

export type Route = {
  id: string;
  name: string;
  created_at: string;
  stops: Stop[];
};

export const api = {
  listRoutes: () => request<Route[]>("/routes"),
  getRoute: (id: string) => request<Route>(`/routes/${id}`),
  deleteRoute: (id: string) =>
    request<{ ok: boolean }>(`/routes/${id}`, { method: "DELETE" }),
  getStop: (routeId: string, stopId: string) =>
    request<Stop>(`/routes/${routeId}/stops/${stopId}`),
  deliverStop: (routeId: string, stopId: string, body: { photo_base64?: string; signature_base64?: string }) =>
    request<{ ok: boolean }>(`/routes/${routeId}/stops/${stopId}/deliver`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  absentStop: (routeId: string, stopId: string, body: { note?: string }) =>
    request<{ ok: boolean }>(`/routes/${routeId}/stops/${stopId}/absent`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resetStop: (routeId: string, stopId: string) =>
    request<{ ok: boolean }>(`/routes/${routeId}/stops/${stopId}/reset`, {
      method: "POST",
    }),
  uploadManifest: (pdf_base64: string, name?: string) =>
    request<Route>(`/manifest/upload`, {
      method: "POST",
      body: JSON.stringify({ pdf_base64, name }),
    }),
};
