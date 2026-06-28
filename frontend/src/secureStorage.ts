/**
 * Cross-platform secure storage wrapper.
 *
 * - On native (iOS/Android): uses expo-secure-store (keychain / encrypted SP).
 * - On web (Expo preview / dev): falls back to localStorage. SecureStore throws
 *   on web in newer Expo SDKs, so we feature-detect at runtime.
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const isWeb = Platform.OS === "web";

function webStorage(): Storage | null {
  // @ts-expect-error - window exists only on web
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  return null;
}

export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (isWeb) {
      const s = webStorage();
      return s ? s.getItem(key) : null;
    }
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    if (isWeb) {
      const s = webStorage();
      if (s) s.setItem(key, value);
      return;
    }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      /* ignore */
    }
  },
  async removeItem(key: string): Promise<void> {
    if (isWeb) {
      const s = webStorage();
      if (s) s.removeItem(key);
      return;
    }
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
  },
};
