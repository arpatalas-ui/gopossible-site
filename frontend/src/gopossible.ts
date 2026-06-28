/**
 * GoPossible portal API client.
 *
 * Three endpoints:
 *  - POST /api/auth/login-password         → session token for the courier
 *  - GET  /api/courier/my-routes           → list of routes assigned to the courier
 *  - POST /api/courier-tracking            → live GPS push (X-Courier-Token header)
 *
 * Configuration lives in `frontend/.env`:
 *   EXPO_PUBLIC_GOPOSSIBLE_URL
 *   EXPO_PUBLIC_COURIER_TRACKING_TOKEN
 */

const PORTAL_BASE =
  process.env.EXPO_PUBLIC_GOPOSSIBLE_URL?.replace(/\/$/, "") ||
  "https://form-automator-10.preview.emergentagent.com";

const TRACKING_TOKEN = process.env.EXPO_PUBLIC_COURIER_TRACKING_TOKEN || "";

export type GoPossibleUser = {
  user_id: string;
  username: string;
  name: string;
  role: string;
  status: string;
  permissions: string[];
  session_token: string;
};

export type CourierAssignment = {
  id: string;
  courier_route_id: string;
  courier_route_name: string;
  user_id?: string;
  username?: string;
  assigned_at: string;
  plan_id?: string;
};

export class PortalError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function asJsonOrText(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

export const portal = {
  /** Sign in with username/password. Returns the full user payload including
   *  the `session_token` which the caller MUST persist (SecureStore). */
  async login(username: string, password: string): Promise<GoPossibleUser> {
    const res = await fetch(`${PORTAL_BASE}/api/auth/login-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await asJsonOrText(res);
    if (res.status === 200) return body as GoPossibleUser;

    if (res.status === 401) throw new PortalError("Nieprawidłowy login lub hasło", 401);
    if (res.status === 403) {
      throw new PortalError(
        body?.detail || "Konto czeka na zatwierdzenie przez administratora",
        403,
      );
    }
    throw new PortalError(body?.detail || `Błąd ${res.status}`, res.status);
  },

  /** Routes assigned to the currently signed-in courier. */
  async getMyRoutes(sessionToken: string): Promise<CourierAssignment[]> {
    const res = await fetch(`${PORTAL_BASE}/api/courier/my-routes`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.status === 401) throw new PortalError("Sesja wygasła — zaloguj się ponownie", 401);
    if (!res.ok) {
      const body = await asJsonOrText(res);
      throw new PortalError(body?.detail || `Błąd ${res.status}`, res.status);
    }
    const data = await res.json();
    return (data.assignments || []) as CourierAssignment[];
  },

  /** Push one GPS sample to the portal. Fire-and-forget — never throws so the
   *  tracking loop keeps running even when the portal is briefly unreachable. */
  async pushTracking(payload: {
    courier_route_id: string;
    lat: number;
    lng: number;
    speed_kmh?: number | null;
    accuracy?: number | null;
    courier_name?: string;
  }): Promise<{ ok: boolean; stored_at?: string }> {
    if (!TRACKING_TOKEN) {
      return { ok: false };
    }
    try {
      const res = await fetch(`${PORTAL_BASE}/api/courier-tracking`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Courier-Token": TRACKING_TOKEN,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return { ok: false };
      return await res.json();
    } catch {
      return { ok: false };
    }
  },
};

export const PORTAL_URL = PORTAL_BASE;
export const HAS_TRACKING_TOKEN = !!TRACKING_TOKEN;
