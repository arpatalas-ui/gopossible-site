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
import { portal, CourierAssignment, PortalError } from "@/src/gopossible";
import { useAuth } from "@/src/authContext";
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
  const { token } = useAuth();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [assignments, setAssignments] = useState<CourierAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const tasks: Promise<unknown>[] = [api.listRoutes().then(setRoutes)];
      if (token) {
        tasks.push(
          portal.getMyRoutes(token)
            .then(setAssignments)
            .catch((e) => {
              if (e instanceof PortalError && e.status === 401) {
                // Token expired — handled by AuthProvider on next mount; just clear list.
                setAssignments([]);
              } else {
                console.warn("[portal] my-routes failed", e);
              }
            }),
        );
      } else {
        setAssignments([]);
      }
      await Promise.all(tasks);
    } catch (e: any) {
      setError(e?.message || "Błąd ładowania tras");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

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

  // Filter visible routes by GoPossible's "my-routes" assignments.
  // The portal's courier_route_id matches our local route.id 1-to-1, so it's
  // a straightforward Set intersection. If the courier has no assignments
  // we fall back to showing everything (so manually-uploaded local routes
  // still work for offline / unassigned scenarios).
  const assignedIds = new Set(assignments.map((a) => a.courier_route_id));
  const visibleRoutes = assignments.length > 0
    ? routes.filter((r) => assignedIds.has(r.id))
    : routes;
  const unassignedCount = assignments.length > 0
    ? routes.filter((r) => !assignedIds.has(r.id)).length
    : 0;

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="home-screen">
      <View style={styles.header}>
        <SectionLabel text="SYSTEM KURIERSKI" />
        <Image
          source={require("@/assets/images/gopossible-full-logo.png")}
          style={styles.headerLogo}
          resizeMode="contain"
        />
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
      ) : visibleRoutes.length === 0 ? (
        <View style={styles.empty}>
          <Image
            source={{ uri: "https://images.pexels.com/photos/6699401/pexels-photo-6699401.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940" }}
            style={styles.emptyImg}
          />
          <Text style={styles.emptyTitle}>
            {assignments.length === 0 ? "Brak tras" : "Brak przypisanych tras"}
          </Text>
          <Text style={styles.emptyText}>
            {assignments.length === 0
              ? "Wgraj manifest PDF, a AI ułoży kolejność dostaw automatycznie."
              : "Dyspozytor w gopossible.pl nie przypisał Ci jeszcze trasy. Po przypisaniu pojawi się tutaj."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visibleRoutes}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View>
              {assignments.length > 0 && (
                <View style={styles.assignBanner}>
                  <Ionicons name="briefcase" size={18} color="#fff" />
                  <Text style={styles.assignBannerText}>
                    PRZYPISANE PRZEZ GoPOSSIBLE: {assignments.length}
                  </Text>
                </View>
              )}
              <SectionLabel
                text={assignments.length > 0 ? "MOJE PRZYPISANE TRASY" : "MOJE TRASY"}
                style={styles.listHeader}
              />
              {unassignedCount > 0 && (
                <Text style={styles.unassignedHint}>
                  Ukrytych {unassignedCount} {unassignedCount === 1 ? "trasa nieprzypisana" : "tras nieprzypisanych"} przez dyspozytora.
                </Text>
              )}
            </View>
          }
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
  headerLogo: { width: 240, height: 64, marginTop: 6, marginBottom: 2 },
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
  assignBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.text, paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 10, marginBottom: 10,
  },
  assignBannerText: { color: "#fff", fontSize: 12, fontWeight: "900", letterSpacing: 0.8, flex: 1 },
  unassignedHint: { color: colors.textSecondary, fontSize: 11, marginBottom: 8, fontStyle: "italic" },
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
