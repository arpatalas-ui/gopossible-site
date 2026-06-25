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
import { SectionLabel } from "@/src/components/SectionLabel";

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
        type: ["application/pdf", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      setUploading(true);
      setError(null);

      let base64: string;
      if (Platform.OS === "web") {
        // @ts-expect-error - "file" is provided by expo-document-picker on web only
        const webFile: Blob | undefined = asset.file;
        const blob = webFile || (await (await fetch(asset.uri)).blob());
        base64 = await blobToBase64(blob);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const FileSystem = require("expo-file-system/legacy");
        base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }

      const route = await api.uploadManifest(base64, asset.name?.replace(/\.(pdf|xlsx?)$/i, ""));
      await load();
      router.push(`/route/${route.id}/review`);
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
    const codCount = r.stops.filter((s) => s.is_cod || s.cod_amount > 0).length;
    return { total, delivered, cod, codCount };
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="home-screen">
      <View style={styles.header}>
        <SectionLabel text="SYSTEM KURIERSKI" />
        <View style={styles.brandRow}>
          <View style={styles.brandTile}>
            <Text style={styles.brandTileText}>GO</Text>
          </View>
          <Text style={styles.brandWordmark}>
            <Text style={{ color: colors.primary }}>KURIER</Text>
            <Text style={{ color: colors.text }}>.</Text>
          </Text>
        </View>
        <Text style={styles.subtitle}>Wgraj manifest PDF — AI utworzy trasę i pokaże paczki na mapie.</Text>
      </View>

      <View style={styles.ctaRow}>
        <TouchableOpacity
          style={[styles.uploadBtn, uploading && styles.uploadBtnDisabled]}
          onPress={onUpload}
          disabled={uploading}
          testID="upload-manifest-btn"
        >
          {uploading ? (
            <>
              <ActivityIndicator color="#fff" />
              <Text style={styles.uploadBtnText}>  AI parsuje…</Text>
            </>
          ) : (
            <>
              <Ionicons name="cloud-upload" size={22} color="#fff" />
              <Text style={styles.uploadBtnText}>  WGRAJ MANIFEST PDF / XLS</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.scanBtn}
          onPress={() => router.push("/scan")}
          testID="scan-qr-btn"
        >
          <Ionicons name="qr-code-outline" size={20} color={colors.text} />
          <Text style={styles.scanBtnText}>  SKANUJ KOD Z gopossible.pl</Text>
        </TouchableOpacity>
      </View>

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
          ListHeaderComponent={<SectionLabel text="MOJE TRASY" style={styles.listHeader} />}
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
                    {s.codCount > 0 ? `  •  ${s.codCount} pobranie` : ""}
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
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  brandRow: { flexDirection: "row", alignItems: "center", marginTop: 6, marginBottom: 2 },
  brandTile: {
    backgroundColor: colors.primary,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 10,
  },
  brandTileText: { color: "#fff", fontSize: 16, fontWeight: "900", letterSpacing: 1 },
  brandWordmark: { fontSize: 36, fontWeight: "900", letterSpacing: -1, lineHeight: 40 },
  subtitle: { fontSize: 14, color: colors.textSecondary, marginTop: 8, lineHeight: 20 },
  ctaRow: { paddingHorizontal: 20, marginTop: 16, marginBottom: 8 },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    height: 56,
    borderRadius: 12,
    boxShadow: "0px 4px 10px rgba(230,51,41,0.25)",
    elevation: 3,
  },
  uploadBtnDisabled: { opacity: 0.7 },
  uploadBtnText: { color: "#fff", fontSize: 15, fontWeight: "900", letterSpacing: 0.8 },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
    height: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.text,
    marginTop: 10,
  },
  scanBtnText: { color: colors.text, fontSize: 13, fontWeight: "900", letterSpacing: 0.8 },
  listHeader: { paddingBottom: 12, paddingHorizontal: 4 },
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
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  routeName: { fontSize: 18, fontWeight: "800", color: colors.text },
  routeMeta: { fontSize: 14, color: colors.textSecondary, marginTop: 4 },
});
