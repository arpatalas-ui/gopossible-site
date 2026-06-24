import React, { useCallback, useState } from "react";
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { api, Route, Stop } from "@/src/api";
import { colors } from "@/src/theme";
import { CodBadge } from "@/src/components/CodBadge";
import { StatusBadge } from "@/src/components/StatusBadge";

export default function RouteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const data = await api.getRoute(id);
      setRoute(data);
    } catch (e: any) {
      setError(e?.message || "Błąd ładowania trasy");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const totalCod = route?.stops.reduce((s, st) => s + (st.cod_amount || 0), 0) || 0;
  const delivered = route?.stops.filter((s) => s.status === "delivered").length || 0;
  const total = route?.stops.length || 0;

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="route-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="back-btn">
          <Ionicons name="chevron-back" size={28} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{route?.name || "Trasa"}</Text>
          <Text style={styles.subtitle}>
            {delivered}/{total} dostarczonych
            {totalCod > 0 ? `  •  ${totalCod.toFixed(2)} PLN pobrania` : ""}
          </Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={route?.stops || []}
          keyExtractor={(s) => s.id}
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
          renderItem={({ item }) => (
            <StopRow stop={item} onPress={() => router.push(`/route/${id}/stop/${item.id}`)} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>Brak paczek w tej trasie</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function StopRow({ stop, onPress }: { stop: Stop; onPress: () => void }) {
  const isDone = stop.status !== "pending";
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.stopCard, isDone && styles.stopCardDone]}
      testID={`stop-row-${stop.id}`}
    >
      <View style={styles.orderBubble}>
        <Text style={styles.orderText}>{stop.order}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.address} numberOfLines={2}>{stop.address}</Text>
        {!!stop.recipient_name && (
          <Text style={styles.recipient} numberOfLines={1}>{stop.recipient_name}</Text>
        )}
        <Text style={styles.pkgCount}>
          {stop.package_numbers.length} {stop.package_numbers.length === 1 ? "paczka" : "paczki"}
        </Text>
        <View style={styles.badgeRow}>
          <StatusBadge status={stop.status} />
          {stop.cod_amount > 0 ? (
            <View style={{ marginLeft: 8 }}>
              <CodBadge amount={stop.cod_amount} />
            </View>
          ) : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={26} color={colors.textSecondary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
  },
  backBtn: { padding: 8, marginRight: 4 },
  title: { fontSize: 22, fontWeight: "900", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: colors.error, fontWeight: "700" },
  emptyText: { color: colors.textSecondary },
  listContent: { padding: 16, paddingBottom: 32 },
  stopCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: "transparent",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  stopCardDone: { opacity: 0.7 },
  orderBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  orderText: { color: "#fff", fontWeight: "900", fontSize: 16 },
  address: { fontSize: 16, fontWeight: "800", color: colors.text, lineHeight: 22 },
  recipient: { fontSize: 14, color: colors.textSecondary, marginTop: 2 },
  pkgCount: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  badgeRow: { flexDirection: "row", alignItems: "center", marginTop: 8, flexWrap: "wrap", gap: 6 },
});
