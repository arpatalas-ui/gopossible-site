import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Linking,
  Modal,
  TextInput,
  Platform,
  Alert,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";

import { api, Route, Stop } from "@/src/api";
import { colors } from "@/src/theme";
import { NavigateMap, PlaceholderMap } from "@/src/components/NavigateMap";
import { CodBadge } from "@/src/components/CodBadge";

type LatLng = { lat: number; lng: number };

type Maneuver = {
  type: string;
  modifier?: string;
  location: [number, number]; // [lng, lat]
};

type RouteStep = {
  maneuver: Maneuver;
  name: string;
  distance: number;
};

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatDuration(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return `${h} h ${r} min`;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Map an OSRM maneuver to an icon name + Polish label.
function maneuverHint(m?: Maneuver): { icon: keyof typeof Ionicons.glyphMap; label: string } {
  if (!m) return { icon: "arrow-up", label: "Prosto" };
  const t = m.type;
  const mod = m.modifier || "";
  if (t === "arrive") return { icon: "flag", label: "Cel" };
  if (t === "depart") return { icon: "arrow-up", label: "Ruszaj" };
  if (mod.includes("uturn") || t === "uturn") return { icon: "arrow-undo", label: "Zawracaj" };
  if (mod.includes("sharp left")) return { icon: "return-up-back", label: "Ostro w lewo" };
  if (mod.includes("sharp right")) return { icon: "return-up-forward", label: "Ostro w prawo" };
  if (mod.includes("slight left")) return { icon: "arrow-back", label: "Lekko w lewo" };
  if (mod.includes("slight right")) return { icon: "arrow-forward", label: "Lekko w prawo" };
  if (mod === "left") return { icon: "arrow-back", label: "W lewo" };
  if (mod === "right") return { icon: "arrow-forward", label: "W prawo" };
  if (mod === "straight" || t === "continue") return { icon: "arrow-up", label: "Prosto" };
  if (t === "roundabout" || t === "rotary") return { icon: "sync", label: "Rondo" };
  return { icon: "arrow-up", label: "Prosto" };
}

export default function NavigateScreen() {
  const { id, stopId } = useLocalSearchParams<{ id: string; stopId: string }>();
  const router = useRouter();
  const [route, setRoute] = useState<Route | null>(null);
  const [user, setUser] = useState<LatLng | null>(null);
  const [permission, setPermission] = useState<Location.LocationPermissionResponse | null>(null);
  const [permRequesting, setPermRequesting] = useState(false);
  const [polyline, setPolyline] = useState<Array<[number, number]> | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeInfo, setRouteInfo] = useState<{ distance: number; duration: number } | null>(null);
  const [steps, setSteps] = useState<RouteStep[]>([]);
  const [stepIndex, setStepIndex] = useState(1); // skip depart
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchAddr, setSearchAddr] = useState("");
  const [searching, setSearching] = useState(false);

  const handleSearch = async () => {
    const addr = searchAddr.trim();
    if (!addr) return;
    setSearching(true);
    try {
      const r = await api.geocodeAddress(addr);
      const url = Platform.select({
        ios: `maps:?daddr=${r.lat},${r.lng}&dirflg=d`,
        android: `geo:0,0?q=${r.lat},${r.lng}(${encodeURIComponent(addr)})`,
        default: `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=18/${r.lat}/${r.lng}`,
      }) as string;
      setSearchOpen(false);
      setSearchAddr("");
      Linking.openURL(url).catch(() => Alert.alert("Mapa", `${addr}\n${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`));
    } catch (e: any) {
      Alert.alert("Nie znaleziono", e?.message || "Adres nie został zlokalizowany.");
    } finally {
      setSearching(false);
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [heading, setHeading] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);

  // Load route data (with polling while any stop lacks coordinates).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const r = await api.getRoute(id);
        if (cancelled) return;
        setRoute(r);
        const missing = r.stops.some((s) => s.lat == null || s.lng == null);
        if (missing && !cancelled) {
          timer = setTimeout(fetchOnce, 8000);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Błąd ładowania trasy");
      }
    };
    fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  // Request location permission contextually
  const requestLocation = useCallback(async () => {
    setPermRequesting(true);
    try {
      const current = await Location.getForegroundPermissionsAsync();
      let resp = current;
      if (current.status !== "granted") {
        if (!current.canAskAgain) {
          setPermission(current);
          return false;
        }
        resp = await Location.requestForegroundPermissionsAsync();
      }
      setPermission(resp);
      if (resp.status === "granted") {
        try {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setUser({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    } finally {
      setPermRequesting(false);
    }
  }, []);

  // Start / stop navigation (with continuous tracking)
  const startNavigation = useCallback(async () => {
    // Enter navigating state immediately so the user gets visual feedback
    // (permission banner, "Ustawienia" link) even when permission is denied.
    setNavigating(true);
    await requestLocation();
  }, [requestLocation]);

  const stopNavigation = useCallback(() => {
    setNavigating(false);
  }, []);

  // Continuous position tracking while navigating
  useEffect(() => {
    if (!navigating) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      try {
        const next = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 5000 },
          (loc) => setUser({ lat: loc.coords.latitude, lng: loc.coords.longitude }),
        );
        if (cancelled) {
          try { next.remove(); } catch { /* noop */ }
        } else {
          sub = next;
        }
      } catch {
        // expo-location's web shim may not support watchPositionAsync — that's OK,
        // we still have the one-shot user position from requestLocation.
      }
    })();
    return () => {
      cancelled = true;
      if (sub) {
        try { sub.remove(); } catch { /* noop — web shim quirk */ }
      }
    };
  }, [navigating]);

  const currentStop: Stop | null = useMemo(() => {
    return route?.stops.find((s) => s.id === stopId) || null;
  }, [route, stopId]);

  const nextStops: Stop[] = useMemo(() => {
    if (!route || !currentStop) return [];
    const idx = route.stops.findIndex((s) => s.id === currentStop.id);
    if (idx < 0) return [];
    return route.stops.slice(idx + 1, idx + 6);
  }, [route, currentStop]);

  // Fetch OSRM road route from user → target — only while navigating
  useEffect(() => {
    if (!navigating) return;
    if (!user || !currentStop || typeof currentStop.lat !== "number" || typeof currentStop.lng !== "number") return;
    let cancelled = false;
    setRouting(true);
    const url = `https://router.project-osrm.org/route/v1/driving/${user.lng},${user.lat};${currentStop.lng},${currentStop.lat}?overview=full&geometries=geojson&steps=true`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const r = data?.routes?.[0];
        if (r?.geometry?.coordinates) {
          // OSRM returns [lng,lat] — flip to [lat,lng] for Leaflet
          const coords: Array<[number, number]> = r.geometry.coordinates.map((c: number[]) => [c[1], c[0]]);
          setPolyline(coords);
          setRouteInfo({ distance: r.distance, duration: r.duration });
          // Flatten OSRM steps across all legs.
          const allSteps: RouteStep[] = (r.legs || []).flatMap((l: { steps?: RouteStep[] }) => l.steps || []);
          setSteps(allSteps);
          setStepIndex(allSteps.length > 1 ? 1 : 0);
        }
      })
      .catch(() => {
        // ignore — fall back to straight line
      })
      .finally(() => !cancelled && setRouting(false));
    return () => {
      cancelled = true;
    };
  }, [navigating, user, currentStop]);

  // Advance step index as user passes maneuvers.
  useEffect(() => {
    if (!navigating || !user || steps.length === 0) return;
    let idx = stepIndex;
    while (idx < steps.length - 1) {
      const [lng, lat] = steps[idx].maneuver.location;
      const d = haversine(user.lat, user.lng, lat, lng);
      if (d < 25) idx++;
      else break;
    }
    if (idx !== stepIndex) setStepIndex(idx);
  }, [user, navigating, steps, stepIndex]);

  // Distance from user to next maneuver point.
  const compass = useMemo(() => {
    if (!navigating || !user || steps.length === 0 || stepIndex >= steps.length) return null;
    const step = steps[stepIndex];
    const [lng, lat] = step.maneuver.location;
    const d = haversine(user.lat, user.lng, lat, lng);
    const hint = maneuverHint(step.maneuver);
    // step.name = road we will be on AFTER this maneuver (or current road for depart)
    const road = step.name || (stepIndex + 1 < steps.length ? steps[stepIndex + 1].name : "");
    return { distance: d, hint, road };
  }, [navigating, user, steps, stepIndex]);
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!route || !currentStop) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const noTargetCoords = typeof currentStop.lat !== "number" || typeof currentStop.lng !== "number";
  const permDenied = permission && permission.status !== "granted";

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="navigate-screen">
      {/* Map */}
      <View style={styles.mapContainer}>
        {noTargetCoords ? (
          <PlaceholderMap message="Rozpoznawanie adresu… mapa pojawi się za chwilę. Możesz już dzwonić, wysyłać SMS lub oznaczyć dostawę." />
        ) : (
          <NavigateMap
            user={navigating ? user : null}
            target={currentStop}
            next={nextStops}
            polyline={navigating ? (polyline || undefined) : undefined}
            heading={navigating ? heading : null}
            follow={navigating && follow}
          />
        )}

        {/* Compass bar (turn-by-turn) — overlays top of map when navigating */}
        {compass && (
          <SafeAreaView style={[styles.compassWrap, { pointerEvents: "box-none" }]} edges={["top"]} testID="compass-bar">
            <View style={styles.compassRow}>
              <View style={styles.compassIcon}>
                <Ionicons name={compass.hint.icon} size={36} color="#fff" />
              </View>
              <View style={{ flex: 1, paddingLeft: 12 }}>
                <Text style={styles.compassDistance}>{formatDistance(compass.distance)}</Text>
                <Text style={styles.compassRoad} numberOfLines={1}>
                  {compass.hint.label}{compass.road ? ` • ${compass.road}` : ""}
                </Text>
              </View>
            </View>
          </SafeAreaView>
        )}

        {/* Top bar overlay */}
        <SafeAreaView
          style={[styles.topBar, compass && styles.topBarShifted, { pointerEvents: "box-none" }]}
          edges={compass ? [] : ["top"]}
        >
          <View style={styles.topBarRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="back-btn">
              <Ionicons name="chevron-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <View style={styles.topInfo}>
              <Text style={styles.topTitle} numberOfLines={1}>
                Stop #{currentStop.order} z {route.stops.length}
              </Text>
              {!navigating ? (
                <Text style={styles.topSubtitle}>Nawigacja zatrzymana — naciśnij start poniżej</Text>
              ) : routing ? (
                <Text style={styles.topSubtitle}>Liczę trasę…</Text>
              ) : routeInfo ? (
                <Text style={[styles.topSubtitle, styles.topSubtitleActive]}>
                  {formatDistance(routeInfo.distance)}  •  {formatDuration(routeInfo.duration)}
                </Text>
              ) : permDenied ? (
                <Text style={styles.topSubtitle}>Brak dostępu do lokalizacji</Text>
              ) : !user ? (
                <Text style={styles.topSubtitle}>Pobieram lokalizację…</Text>
              ) : (
                <Text style={styles.topSubtitle}>Linia prosta</Text>
              )}
            </View>
            {navigating && user && (
              <TouchableOpacity
                onPress={() => setFollow((f) => !f)}
                style={[styles.iconBtn, follow && styles.iconBtnActive]}
                testID="recenter-btn"
              >
                <Ionicons name={follow ? "navigate" : "navigate-outline"} size={22} color={follow ? "#fff" : colors.text} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => setSearchOpen(true)}
              style={styles.iconBtn}
              testID="search-address-btn"
            >
              <Ionicons name="search" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>

      {/* Permission denied banner — only after user attempted to start */}
      {navigating && permDenied && (
        <View style={styles.permBanner}>
          <Ionicons name="location-outline" size={20} color={colors.warning} />
          <Text style={styles.permText}>
            {permission?.canAskAgain
              ? "Włącz lokalizację aby zobaczyć trasę od siebie do paczki"
              : "Lokalizacja zablokowana. Włącz w ustawieniach systemu"}
          </Text>
          {permission?.canAskAgain ? (
            <TouchableOpacity onPress={requestLocation} disabled={permRequesting} testID="grant-loc-btn">
              <Text style={styles.permAction}>{permRequesting ? "…" : "Włącz"}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => Linking.openSettings()} testID="open-settings-btn">
              <Text style={styles.permAction}>Ustawienia</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Bottom panel */}
      <View style={styles.bottom}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Current target */}
          <View style={styles.targetCard}>
            <View style={styles.orderBubble}>
              <Text style={styles.orderText}>{currentStop.order}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.address} numberOfLines={2}>{currentStop.address}</Text>
              {!!currentStop.recipient_name && (
                <Text style={styles.recipient} numberOfLines={1}>{currentStop.recipient_name}</Text>
              )}
              {(currentStop.is_cod || currentStop.cod_amount > 0) && (
                <View style={{ marginTop: 6 }}>
                  <CodBadge amount={currentStop.cod_amount} isCod={currentStop.is_cod} />
                </View>
              )}
            </View>
          </View>

          {/* Next stops preview */}
          {nextStops.length > 0 && (
            <View style={styles.nextWrap}>
              <Text style={styles.nextLabel}>NASTĘPNE PUNKTY</Text>
              {nextStops.slice(0, 3).map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={styles.nextRow}
                  onPress={() => router.replace(`/route/${id}/stop/${s.id}/navigate`)}
                  testID={`next-row-${s.id}`}
                >
                  <View style={styles.nextBubble}><Text style={styles.nextBubbleText}>{s.order}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.nextAddr} numberOfLines={1}>{s.address}</Text>
                    {!!s.recipient_name && (
                      <Text style={styles.nextRec} numberOfLines={1}>{s.recipient_name}</Text>
                    )}
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>

        {/* Start / Stop navigation button */}
        {currentStop.status === "pending" && !noTargetCoords && (
          !navigating ? (
            <TouchableOpacity
              style={styles.startBtn}
              onPress={startNavigation}
              disabled={permRequesting}
              testID="start-nav-btn"
            >
              {permRequesting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="navigate" size={22} color="#fff" />
                  <Text style={styles.startBtnText}>  Rozpocznij nawigację</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.stopBtn}
              onPress={stopNavigation}
              testID="stop-nav-btn"
            >
              <Ionicons name="stop-circle" size={20} color={colors.text} />
              <Text style={styles.stopBtnText}>  Zatrzymaj nawigację</Text>
            </TouchableOpacity>
          )
        )}

        {/* Action buttons */}
        {currentStop.status === "pending" ? (
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.absentBtn]}
              onPress={() => router.push(`/route/${id}/stop/${stopId}/absent`)}
              testID="mark-absent-btn"
            >
              <Ionicons name="person-remove" size={20} color="#fff" />
              <Text style={styles.actionText}>Nieobecny</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.deliveredBtn]}
              onPress={() => router.push(`/route/${id}/stop/${stopId}/deliver`)}
              testID="mark-delivered-btn"
            >
              <Ionicons name="checkmark-circle" size={20} color="#fff" />
              <Text style={styles.actionText}>Dostarczono</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.deliveredBtn, { flex: 1 }]}
              onPress={() => {
                const idx = route.stops.findIndex((s) => s.id === currentStop.id);
                const nx = route.stops[idx + 1];
                if (nx) router.replace(`/route/${id}/stop/${nx.id}/navigate`);
                else router.replace(`/route/${id}`);
              }}
              testID="next-stop-btn"
            >
              <Text style={styles.actionText}>Następny punkt →</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <Modal visible={searchOpen} transparent animationType="slide" onRequestClose={() => setSearchOpen(false)}>
        <View style={styles.searchBackdrop}>
          <SafeAreaView style={styles.searchCard} edges={["bottom"]}>
            <View style={styles.searchHeader}>
              <Ionicons name="search" size={22} color={colors.text} />
              <Text style={styles.searchTitle}>Wyszukaj adres</Text>
              <TouchableOpacity onPress={() => setSearchOpen(false)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>
            <TextInput
              value={searchAddr}
              onChangeText={setSearchAddr}
              placeholder="np. Wojska Polskiego 81, Szczecin"
              placeholderTextColor={colors.textSecondary}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={handleSearch}
              returnKeyType="search"
              style={styles.searchInput}
              testID="navigate-search-input"
            />
            <TouchableOpacity
              style={[styles.searchSubmit, (!searchAddr.trim() || searching) && { opacity: 0.55 }]}
              onPress={handleSearch}
              disabled={!searchAddr.trim() || searching}
              testID="navigate-search-submit"
            >
              {searching ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="navigate-circle" size={20} color="#fff" />
                  <Text style={styles.searchSubmitText}>  POPROWADŹ MNIE TAM</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={styles.searchHint}>
              Otworzy się Twoja domyślna aplikacja map z trasą do wpisanego adresu.
            </Text>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { color: colors.error, fontWeight: "700" },
  mapContainer: { flex: 1, position: "relative" },
  compassWrap: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 10 },
  compassRow: {
    flexDirection: "row", alignItems: "center",
    marginHorizontal: 12, marginTop: 12, padding: 12,
    backgroundColor: colors.primary, borderRadius: 14,
    boxShadow: "0px 4px 10px rgba(0,0,0,0.25)", elevation: 6,
  },
  compassIcon: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center", justifyContent: "center",
  },
  compassDistance: { color: "#fff", fontSize: 22, fontWeight: "900" },
  compassRoad: { color: "rgba(255,255,255,0.92)", fontSize: 13, fontWeight: "700", marginTop: 2 },
  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
  topBarShifted: { top: 96 },
  topBarRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 6,
    boxShadow: "0px 4px 8px rgba(0,0,0,0.15)",
    elevation: 4,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
  },
  iconBtnActive: { backgroundColor: colors.primary },
  topInfo: { flex: 1, paddingHorizontal: 8 },
  topTitle: { fontSize: 15, fontWeight: "900", color: colors.text },
  topSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  topSubtitleActive: { color: colors.primary, fontWeight: "800" },
  permBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#FFF8E1", paddingHorizontal: 14, paddingVertical: 10,
    borderTopWidth: 1, borderColor: "#FFE082",
  },
  permText: { flex: 1, fontSize: 12, color: colors.text },
  permAction: { color: colors.primary, fontWeight: "900", fontSize: 13 },
  bottom: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingTop: 12, paddingHorizontal: 16, paddingBottom: 16,
    maxHeight: 360,
    boxShadow: "0px -4px 12px rgba(0,0,0,0.08)", elevation: 6,
  },
  targetCard: {
    flexDirection: "row", alignItems: "center", paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 8,
  },
  orderBubble: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginRight: 12,
  },
  orderText: { color: "#fff", fontWeight: "900", fontSize: 17 },
  address: { fontSize: 17, fontWeight: "900", color: colors.text, lineHeight: 22 },
  recipient: { fontSize: 14, color: colors.textSecondary, marginTop: 2 },
  nextWrap: { marginBottom: 8 },
  nextLabel: {
    fontSize: 10, fontWeight: "900", letterSpacing: 1.2,
    color: colors.textSecondary, marginBottom: 6, marginTop: 4,
  },
  nextRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: 8,
  },
  nextBubble: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.text,
    alignItems: "center", justifyContent: "center", marginRight: 10,
  },
  nextBubbleText: { color: "#fff", fontWeight: "800", fontSize: 12 },
  nextAddr: { fontSize: 14, color: colors.text, fontWeight: "700" },
  nextRec: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  actionsRow: {
    flexDirection: "row", gap: 10, marginTop: 8,
  },
  startBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, height: 60, borderRadius: 999, marginTop: 8,
  },
  startBtnText: { color: "#fff", fontWeight: "900", fontSize: 17 },
  stopBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.card, height: 50, borderRadius: 999, marginTop: 8,
    borderWidth: 2, borderColor: colors.text,
  },
  stopBtnText: { color: colors.text, fontWeight: "800", fontSize: 15 },
  actionBtn: {
    flex: 1, height: 56, borderRadius: 999,
    alignItems: "center", justifyContent: "center",
    flexDirection: "row", gap: 6,
  },
  deliveredBtn: { backgroundColor: colors.success },
  absentBtn: { backgroundColor: colors.absent },
  actionText: { color: "#fff", fontWeight: "900", fontSize: 15 },
  searchBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  searchCard: {
    backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, gap: 12,
  },
  searchHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  searchTitle: { flex: 1, fontSize: 17, fontWeight: "900", color: colors.text },
  searchInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 14, fontSize: 15, color: colors.text,
    backgroundColor: colors.bg,
  },
  searchSubmit: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, height: 50, borderRadius: 12,
  },
  searchSubmitText: { color: "#fff", fontWeight: "900", letterSpacing: 0.6, fontSize: 14 },
  searchHint: { color: colors.textSecondary, fontSize: 12, textAlign: "center" },
});
