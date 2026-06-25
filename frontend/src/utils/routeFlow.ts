import { api, Route, Stop } from "@/src/api";

/**
 * Given a route and the id of the stop the courier just finished,
 * pick the next pending stop. Looks forward first, then wraps around
 * to earlier pending stops, otherwise returns null (route complete).
 */
export function findNextPendingStop(route: Route, currentStopId: string): Stop | null {
  const idx = route.stops.findIndex((s) => s.id === currentStopId);
  if (idx < 0) {
    return route.stops.find((s) => s.status === "pending") || null;
  }
  for (let i = idx + 1; i < route.stops.length; i++) {
    if (route.stops[i].status === "pending") return route.stops[i];
  }
  for (let i = 0; i < idx; i++) {
    if (route.stops[i].status === "pending") return route.stops[i];
  }
  return null;
}

/**
 * Fetch the latest route and resolve to a redirect path:
 *  - next pending stop's navigate screen, or
 *  - the route overview if nothing is left.
 */
export async function nextStopPathOrRoute(routeId: string, currentStopId: string): Promise<string> {
  try {
    const route = await api.getRoute(routeId);
    const next = findNextPendingStop(route, currentStopId);
    if (next) return `/route/${routeId}/stop/${next.id}/navigate`;
  } catch {
    // network hiccup — fall back to overview
  }
  return `/route/${routeId}`;
}
