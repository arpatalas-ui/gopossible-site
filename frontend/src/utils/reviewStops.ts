import { Stop } from "@/src/api";

/**
 * Haversine distance in km between two lat/lng points.
 */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type StopReview = {
  stop: Stop;
  status: "ok" | "no-coords" | "far";
  distanceKm?: number;
};

/**
 * Classify every stop on a route into ok / no-coords / far-from-cluster.
 *
 * - "no-coords"   – the geocoder failed entirely (lat/lng null).
 * - "far"         – pin is > thresholdKm away from the median lat/lng of all
 *                   geocoded stops (heuristic outlier detection — catches the
 *                   "street pinned in another city" bug).
 * - "ok"          – everything else.
 */
export function reviewStops(stops: Stop[], thresholdKm = 5): StopReview[] {
  const withCoords = stops.filter((s) => s.lat != null && s.lng != null) as Required<
    Pick<Stop, "lat" | "lng">
  >[] as unknown as Stop[];

  let center: { lat: number; lng: number } | null = null;
  if (withCoords.length >= 3) {
    center = {
      lat: median(withCoords.map((s) => s.lat as number)),
      lng: median(withCoords.map((s) => s.lng as number)),
    };
  }

  return stops.map<StopReview>((s) => {
    if (s.lat == null || s.lng == null) {
      return { stop: s, status: "no-coords" };
    }
    if (!center) return { stop: s, status: "ok" };
    const d = distanceKm({ lat: s.lat, lng: s.lng }, center);
    if (d > thresholdKm) return { stop: s, status: "far", distanceKm: d };
    return { stop: s, status: "ok", distanceKm: d };
  });
}

export function countIssues(reviews: StopReview[]): { noCoords: number; far: number; total: number } {
  let noCoords = 0;
  let far = 0;
  for (const r of reviews) {
    if (r.status === "no-coords") noCoords += 1;
    else if (r.status === "far") far += 1;
  }
  return { noCoords, far, total: noCoords + far };
}
