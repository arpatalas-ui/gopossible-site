import React, { useCallback, useState } from "react";
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Image,
  Platform,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";

import { api, Route } from "@/src/api";
import { colors } from "@/src/theme";
import { CodBadge } from "@/src/components/CodBadge";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.onload = () => {
      const result = reader.result as string;
      // strip "data:<mime>;base64," prefix
      const idx = result.indexOf("base64,");
      resolve(idx >= 0 ? result.slice(idx + 7) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export default function HomeScreen() {
  const router = useRouter();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api.listRoutes();
      setRoutes(data);
    } catch (e: any) {
      setError(e?.message || "Błąd ładowania tras");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onUpload = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      setUploading(true);
      setError(null);

      let base64: string;
      if (Platform.OS === "web") {
        // On web, DocumentPicker returns a `file` (Blob/File) or a blob URL we can fetch.
        // Prefer the File when available, otherwise fetch the uri.
        // @ts-expect-error - "file" is provided by expo-document-picker on web only
        const webFile: Blob | undefined = asset.file;
        const blob = webFile || (await (await fetch(asset.uri)).blob());
        base64 = await blobToBase64(blob);
      } else {
        // Native: lazy-require expo-file-system so web bundle stays clean.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const FileSystem = require("expo-file-system/legacy");
        base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }

      const route = await api.uploadManifest(base64, asset.name?.replace(/\.pdf$/i, ""));
      await load();
      router.push(`/route/${route.id}`);
    } catch (e: any) {
      setError(e?.message || "Nie udało się wgrać manifestu");
    } finally {
      setUploading(false);
    }
  };

  const summary = (r: Route) => {
    const total = r.stops.length;
    const delivered = r.stops.filter((s) => s.status === "delivered").length;
    const cod = r.stops.reduce((sum, s) => sum + (s.cod_amount || 0), 0);
    return { total, delivered, cod };
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="home-screen">
      <View style={styles.header}>
        <Text style={styles.h1}>Moje Trasy</Text>
        <Text style={styles.subtitle}>Wgraj manifest PDF aby utworzyć nową trasę</Text>
      </View>

      <TouchableOpacity
        style={[styles.uploadBtn, uploading && styles.uploadBtnDisabled]}
        onPress={onUpload}
        disabled={uploading}
        testID="upload-manifest-btn"
      >
        {uploading ? (
          <>
            <ActivityIndicator color="#fff" />
            <Text style={styles.uploadBtnText}>  AI parsuje manifest…</Text>
          </>
        ) : (
          <>
            <Ionicons name="cloud-upload" size={26} color="#fff" />
            <Text style={styles.uploadBtnText}>  Wgraj Manifest PDF</Text>
          </>
        )}
      </TouchableOpacity>

      {error ? (
        <View style={styles.errorBox} testID="error-box">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : routes.length === 0 ? (
        <View style={styles.empty}>
          <Image
            source={{ uri: "https://images.pexels.com/photos/6699401/pexels-photo-6699401.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940" }}
            style={styles.emptyImg}
          />
          <Text style={styles.emptyTitle}>Brak tras</Text>
          <Text style={styles.emptyText}>Wgraj manifest PDF, a AI ułoży kolejność dostaw automatycznie.</Text>
        </View>
      ) : (
        <FlatList
          data={routes}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => {
            const s = summary(item);
            return (
              <TouchableOpacity
                style={styles.routeCard}
                onPress={() => router.push(`/route/${item.id}`)}
                testID={`route-card-${item.id}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.routeName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.routeMeta}>
                    {s.delivered} / {s.total} dostarczonych
                  </Text>
                  {s.cod > 0 ? (
                    <View style={{ marginTop: 8 }}>
                      <CodBadge amount={s.cod} />
                    </View>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={28} color={colors.textSecondary} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  h1: { fontSize: 32, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: colors.textSecondary, marginTop: 4 },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    marginHorizontal: 20,
    height: 64,
    borderRadius: 999,
    marginBottom: 16,
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  uploadBtnDisabled: { opacity: 0.7 },
  uploadBtnText: { color: "#fff", fontSize: 18, fontWeight: "800" },
  errorBox: {
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: "#FFEBEE",
    borderColor: colors.error,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  errorText: { color: colors.error, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyImg: { width: 180, height: 180, borderRadius: 16, marginBottom: 16, opacity: 0.9 },
  emptyTitle: { fontSize: 22, fontWeight: "900", color: colors.text },
  emptyText: { fontSize: 15, color: colors.textSecondary, textAlign: "center", marginTop: 8 },
  listContent: { padding: 20, paddingTop: 4 },
  routeCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  routeName: { fontSize: 18, fontWeight: "800", color: colors.text },
  routeMeta: { fontSize: 14, color: colors.textSecondary, marginTop: 4 },
});
