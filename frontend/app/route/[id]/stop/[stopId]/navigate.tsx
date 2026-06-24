import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Linking,
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
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);

  // Load route data
  useEffect(() => {
    if (!id) return;
    api.getRoute(id).then(setRoute).catch((e) => setError(e?.message || "Błąd ładowania trasy"));
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
    const ok = await requestLocation();
    if (ok || user) setNavigating(true);
  }, [requestLocation, user]);

  const stopNavigation = useCallback(() => {
    setNavigating(false);
  }, []);

  // Continuous position tracking while navigating
  useEffect(() => {
    if (!navigating) return;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      try {
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 5000 },
          (loc) => setUser({ lat: loc.coords.latitude, lng: loc.coords.longitude }),
        );
      } catch {
        // fallthrough
      }
    })();
    return () => {
      if (sub) sub.remove();
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
    const url = `https://router.project-osrm.org/route/v1/driving/${user.lng},${user.lat};${currentStop.lng},${currentStop.lat}?overview=full&geometries=geojson`;
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

  // ----- Renders -----
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
          <PlaceholderMap message="Brak współrzędnych dla tego stopa. Wgraj manifest ponownie aby uzupełnić mapę." />
        ) : (
          <NavigateMap
            user={navigating ? user : null}
            target={currentStop}
            next={nextStops}
            polyline={navigating ? (polyline || undefined) : undefined}
          />
        )}

        {/* Top bar overlay */}
        <SafeAreaView style={styles.topBar} edges={["top"]} pointerEvents="box-none">
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
                onPress={requestLocation}
                style={styles.iconBtn}
                disabled={permRequesting}
                testID="recenter-btn"
              >
                <Ionicons name="locate" size={22} color={colors.text} />
              </TouchableOpacity>
            )}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { color: colors.error, fontWeight: "700" },
  mapContainer: { flex: 1, position: "relative" },
  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
  topBarRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
  },
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
    shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 }, elevation: 6,
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
});
