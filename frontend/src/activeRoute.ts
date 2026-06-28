/**
 * Active route helper — stores the courier_route_id the courier is currently
 * working on so the GPS ping loop can tag every sample with it.
 *
 * Set when entering `/route/[id]`, cleared when leaving back to the home tab
 * or on logout.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@gopossible/active_courier_route_id";

export const activeRoute = {
  async set(routeId: string): Promise<void> {
    try { await AsyncStorage.setItem(KEY, routeId); } catch {}
  },
  async clear(): Promise<void> {
    try { await AsyncStorage.removeItem(KEY); } catch {}
  },
  async get(): Promise<string | null> {
    try { return await AsyncStorage.getItem(KEY); } catch { return null; }
  },
};
