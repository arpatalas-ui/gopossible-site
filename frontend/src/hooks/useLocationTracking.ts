import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

import { api } from "@/src/api";

const PROFILE_KEY = "@gopossible/courier_profile_v1";
const SETTINGS_KEY = "@gopossible/courier_settings_v1";

// 30 seconds — exactly what the user asked for.
const PING_INTERVAL_MS = 30_000;

type Profile = { name?: string; courier_id?: string };
type Settings = { gpsTracking?: boolean };

export type TrackingStatus =
  | "idle"
  | "requesting-permission"
  | "denied"
  | "unsupported"
  | "tracking"
  | "error";

/**
 * Foreground GPS ping loop. Mounts once near the navigation root.
 *
 * - Asks for foreground location permission on first run.
 * - Sends one ping every 30 s while the app is in the foreground.
 * - Pauses cleanly when the app is backgrounded (Expo Go cannot track in
 *   background without a dev build — that's a separate feature).
 * - Respects user toggle stored under `@gopossible/courier_settings_v1`.
 */
export function useLocationTracking() {
  const [status, setStatus] = useState<TrackingStatus>("idle");
  const [lastPingAt, setLastPingAt] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const enabledRef = useRef<boolean>(true);
  const profileRef = useRef<Profile>({});

  // Reload profile + settings whenever AsyncStorage hint fires (we re-read on
  // every ping, so this is mostly cosmetic — but it lets the toggle react
  // immediately without remounting).
  const loadPrefs = async () => {
    try {
      const [p, s] = await Promise.all([
        AsyncStorage.getItem(PROFILE_KEY),
        AsyncStorage.getItem(SETTINGS_KEY),
      ]);
      profileRef.current = p ? JSON.parse(p) : {};
      const settings: Settings = s ? JSON.parse(s) : {};
      enabledRef.current = settings.gpsTracking !== false; // default ON
    } catch {
      enabledRef.current = true;
    }
  };

  const sendPing = async (): Promise<void> => {
    await loadPrefs();
    if (!enabledRef.current) return;

    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude, accuracy, speed, heading, altitude } = pos.coords;
      await api.postLocation({
        courier_id: profileRef.current.courier_id || "",
        courier_name: profileRef.current.name || "",
        lat: latitude,
        lng: longitude,
        accuracy: accuracy ?? null,
        speed: speed ?? null,
        heading: heading ?? null,
        altitude: altitude ?? null,
        client_ts: new Date(pos.timestamp).toISOString(),
      });
      setLastPingAt(new Date().toISOString());
      setStatus("tracking");
    } catch (err) {
      // Network errors / GPS fix failures should not crash the tab UI.
      // Stay in "tracking" so we retry on the next tick.
      console.warn("[gps] ping failed", err);
    }
  };

  const start = async () => {
    if (timerRef.current) return; // already running

    if (Platform.OS === "web") {
      // expo-location can prompt on web too via the Geolocation API, but
      // browsers gate it behind a user gesture. We try once anyway.
      setStatus("unsupported");
      return;
    }

    setStatus("requesting-permission");
    const { status: perm, canAskAgain } = await Location.requestForegroundPermissionsAsync();
    if (perm !== "granted") {
      setStatus("denied");
      // Honour the OS "don't ask again" flag — do not loop on the prompt.
      if (!canAskAgain) return;
      return;
    }

    // First ping right away so the dispatcher sees the courier come online,
    // then on a 30 s interval.
    await sendPing();
    timerRef.current = setInterval(sendPing, PING_INTERVAL_MS);
  };

  const stop = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    loadPrefs().then(() => {
      if (enabledRef.current) start();
      else setStatus("idle");
    });

    // Pause tracking when the app goes to the background — Expo Go cannot
    // legally track without a dev build + background task permission, and on
    // the web there's no foreground notion to chase.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (enabledRef.current) start();
      } else {
        stop();
      }
    });

    return () => {
      sub.remove();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, lastPingAt };
}
