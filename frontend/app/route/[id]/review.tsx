import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
  Platform,
  RefreshControl,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { api, Route, Stop } from "@/src/api";
import { colors } from "@/src/theme";
import { RouteMap } from "@/src/components/RouteMap";
import { SectionLabel } from "@/src/components/SectionLabel";
import { reviewStops, countIssues, StopReview } from "@/src/utils/reviewStops";

export default function ReviewRouteScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [approving, setApproving] = useState(false);

  // Address edit modal
  const [editStop, setEditStop] = useState<Stop | null>(null);
  const [editAddr, setEditAddr] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getRoute(id);
      setRoute(r);
    } catch (e: any) {
      Alert.alert("Błąd", e?.message || "Nie udało się pobrać trasy");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-poll while background geocoding is still running so the courier sees
  // pins fill in without manual refresh.
  useEffect(() => {
    if (!route) return;
    const pending = route.stops.some((s) => s.lat == null);
    if (!pending) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [route, load]);

  const reviews: StopReview[] = useMemo(() => (route ? reviewStops(route.stops, 5) : []), [route]);
  const issues = useMemo(() => countIssues(reviews), [reviews]);
  const outlierIds = useMemo(
    () => reviews.filter((r) => r.status === "far").map((r) => r.stop.id),
    [reviews],
  );
  const problematic = reviews.filter((r) => r.status !== "ok");

  const onApprove = async () => {
    if (!id) return;
    if (issues.total > 0) {
      Alert.alert(
        "Nieprawidłowe adresy",
        `${issues.total} ${issues.total === 1 ? "stop wymaga" : "stopów wymaga"} sprawdzenia. Zatwierdzić mimo to?`,
        [
          { text: "Wróć do edycji", style: "cancel" },
          { text: "Zatwierdź mimo to", style: "destructive", onPress: doApprove },
        ],
      );
      return;
    }
    doApprove();
  };

  const doApprove = async () => {
    if (!id) return;
    setApproving(true);
    try {
      await api.approveRoute(id);
      router.replace(`/route/${id}`);
    } catch (e: any) {
      Alert.alert("Błąd", e?.message || "Nie udało się zatwierdzić trasy");
    } finally {
      setApproving(false);
    }
  };

  const openEdit = (stop: Stop) => {
    setEditStop(stop);
    setEditAddr(stop.address);
  };

  const saveEdit = async () => {
    if (!editStop || !id) return;
    const trimmed = editAddr.trim();
    if (!trimmed) {
      Alert.alert("Adres", "Wpisz nowy adres");
      return;
    }
    setEditSaving(true);
    try {
      const r = await api.updateStopAddress(id, editStop.id, trimmed);
      if (!r.geocoded) {
        Alert.alert(
          "Adres zaktualizowany",
          "Nie udało się znaleźć współrzędnych. Sprawdź pisownię i spróbuj jeszcze raz lub pozostaw — można poprawić później.",
        );
      }
      setEditStop(null);
      await load();
    } catch (e: any) {
      Alert.alert("Błąd", e?.message || "Nie udało się zapisać adresu");
    } finally {
      setEditSaving(false);
    }
  };

  if (loading || !route) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const pendingGeocode = route.stops.filter((s) => s.lat == null).length;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="review-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{route.name}</Text>
          <Text style={styles.headerSub}>Przejrzyj trasę przed startem</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* Stats strip */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{route.stops.length}</Text>
            <Text style={styles.statLabel}>PACZEK</Text>
          </View>
          <View style={[styles.statCard, issues.far > 0 && styles.statCardWarn]}>
            <Text style={[styles.statValue, issues.far > 0 && { color: "#B45309" }]}>{issues.far}</Text>
            <Text style={styles.statLabel}>POZA REJONEM</Text>
          </View>
          <View style={[styles.statCard, issues.noCoords > 0 && styles.statCardErr]}>
            <Text style={[styles.statValue, issues.noCoords > 0 && { color: colors.error }]}>{issues.noCoords}</Text>
            <Text style={styles.statLabel}>BEZ MAPY</Text>
          </View>
        </View>

        {pendingGeocode > 0 && (
          <View style={styles.banner} testID="geocode-banner">
            <ActivityIndicator size="small" color={colors.text} />
            <Text style={styles.bannerText}>
              Geokodowanie w toku — pozostało {pendingGeocode} {pendingGeocode === 1 ? "adres" : "adresów"}…
            </Text>
          </View>
        )}

        {/* Map */}
        <View style={styles.mapWrap}>
          <RouteMap
            stops={route.stops}
            outlierIds={outlierIds}
            height={280}
            onStopPress={(sid) => {
              const s = route.stops.find((x) => x.id === sid);
              if (s) openEdit(s);
            }}
          />
        </View>

        {problematic.length > 0 && (
          <View style={styles.section}>
            <SectionLabel text={`DO SPRAWDZENIA (${problematic.length})`} />
            {problematic.map((r) => (
              <View key={r.stop.id} style={[styles.stopRow, r.status === "no-coords" ? styles.stopRowErr : styles.stopRowWarn]}>
                <View style={styles.orderBubble}>
                  <Text style={styles.orderText}>{r.stop.order}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.recipient} numberOfLines={1}>{r.stop.recipient_name || "—"}</Text>
                  <Text style={styles.address} numberOfLines={2}>{r.stop.address}</Text>
                  <View style={styles.tagRow}>
                    {r.status === "no-coords" ? (
                      <View style={[styles.tag, { backgroundColor: "#FFEBEE" }]}>
                        <Ionicons name="warning" size={11} color={colors.error} />
                        <Text style={[styles.tagText, { color: colors.error }]}>BRAK WSPÓŁRZĘDNYCH</Text>
                      </View>
                    ) : (
                      <View style={[styles.tag, { backgroundColor: "#FFF7E6" }]}>
                        <Ionicons name="alert-circle" size={11} color="#B45309" />
                        <Text style={[styles.tagText, { color: "#B45309" }]}>
                          {r.distanceKm ? `${r.distanceKm.toFixed(0)} KM OD ŚREDNIEJ` : "POZA REJONEM"}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
                <TouchableOpacity style={styles.fixBtn} onPress={() => openEdit(r.stop)} testID={`fix-${r.stop.id}`}>
                  <Ionicons name="create-outline" size={16} color="#fff" />
                  <Text style={styles.fixBtnText}>POPRAW</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* All stops list (compact) */}
        <View style={styles.section}>
          <SectionLabel text={`WSZYSTKIE STOPY (${route.stops.length})`} />
          {route.stops.map((s) => (
            <TouchableOpacity key={s.id} style={styles.compactRow} onPress={() => openEdit(s)}>
              <Text style={styles.compactOrder}>{s.order}.</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.compactRecipient} numberOfLines={1}>{s.recipient_name || "—"}</Text>
                <Text style={styles.compactAddr} numberOfLines={1}>{s.address}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {/* Bottom CTA */}
      <SafeAreaView edges={["bottom"]} style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.approveBtn, approving && { opacity: 0.7 }]}
          onPress={onApprove}
          disabled={approving}
          testID="approve-route-btn"
        >
          {approving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={22} color="#fff" />
              <Text style={styles.approveBtnText}>  ZATWIERDŹ I ROZPOCZNIJ TRASĘ</Text>
            </>
          )}
        </TouchableOpacity>
      </SafeAreaView>

      {/* Edit address modal */}
      <Modal visible={!!editStop} animationType="slide" transparent onRequestClose={() => setEditStop(null)}>
        <View style={styles.modalBackdrop}>
          <SafeAreaView style={styles.modalCard} edges={["bottom"]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Popraw adres</Text>
              <TouchableOpacity onPress={() => setEditStop(null)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalSub}>Stop #{editStop?.order} • {editStop?.recipient_name || "—"}</Text>
            <Text style={styles.modalLabel}>NOWY ADRES</Text>
            <TextInput
              value={editAddr}
              onChangeText={setEditAddr}
              multiline
              placeholder="np. Szczecin, Dubois 23"
              placeholderTextColor={colors.textSecondary}
              style={styles.modalInput}
              autoCorrect={false}
              testID="edit-address-input"
            />
            <Text style={styles.modalHint}>
              Wpisz pełny adres ze Szczecina lub okolic. System ponownie wyszuka pinezkę.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditStop(null)} disabled={editSaving}>
                <Text style={styles.cancelBtnText}>ANULUJ</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, editSaving && { opacity: 0.7 }]}
                onPress={saveEdit}
                disabled={editSaving}
                testID="edit-address-save"
              >
                {editSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveBtnText}>ZAPISZ I WYSZUKAJ</Text>
                )}
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8,
    backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 16, fontWeight: "900", color: colors.text },
  headerSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  statsRow: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  statCard: {
    flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 12, alignItems: "center",
    borderWidth: 1, borderColor: colors.border,
  },
  statCardWarn: { borderColor: "#FFB300", backgroundColor: "#FFFBEB" },
  statCardErr: { borderColor: colors.error, backgroundColor: "#FFEBEE" },
  statValue: { fontSize: 22, fontWeight: "900", color: colors.text },
  statLabel: { fontSize: 10, fontWeight: "900", letterSpacing: 0.5, color: colors.textSecondary, marginTop: 2 },
  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: "#FFF8E1", borderRadius: 10, borderWidth: 1, borderColor: "#FFE082",
    marginBottom: 8,
  },
  bannerText: { fontSize: 12, color: colors.text, fontWeight: "600", flex: 1 },
  mapWrap: { paddingHorizontal: 16 },
  section: { paddingHorizontal: 16, marginTop: 18 },
  stopRow: {
    flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12,
    borderRadius: 12, marginBottom: 8, borderWidth: 2,
  },
  stopRowWarn: { backgroundColor: "#FFF7E6", borderColor: "#FFB300" },
  stopRowErr: { backgroundColor: "#FFEBEE", borderColor: colors.error },
  orderBubble: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  orderText: { color: "#fff", fontWeight: "900", fontSize: 12 },
  recipient: { fontSize: 14, fontWeight: "900", color: colors.text },
  address: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  tag: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6 },
  tagText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.4 },
  fixBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.text, borderRadius: 8,
  },
  fixBtnText: { color: "#fff", fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  compactRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border, gap: 10,
  },
  compactOrder: { fontSize: 13, fontWeight: "900", color: colors.text, width: 28 },
  compactRecipient: { fontSize: 13, fontWeight: "700", color: colors.text },
  compactAddr: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  bottomBar: {
    backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border,
    paddingHorizontal: 16, paddingTop: 10,
  },
  approveBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, height: 56, borderRadius: 12,
    boxShadow: "0px 4px 10px rgba(230,51,41,0.25)", elevation: 3,
  },
  approveBtnText: { color: "#fff", fontWeight: "900", fontSize: 14, letterSpacing: 0.8 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: Platform.OS === "ios" ? 0 : 18,
    gap: 10,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { fontSize: 18, fontWeight: "900", color: colors.text },
  modalSub: { fontSize: 12, color: colors.textSecondary },
  modalLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 0.8, color: colors.textSecondary, marginTop: 8 },
  modalInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    padding: 12, fontSize: 15, color: colors.text, minHeight: 60, backgroundColor: colors.bg,
    textAlignVertical: "top",
  },
  modalHint: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 8 },
  cancelBtn: {
    flex: 1, height: 50, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  cancelBtnText: { color: colors.text, fontWeight: "900", letterSpacing: 0.5 },
  saveBtn: {
    flex: 2, height: 50, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary,
  },
  saveBtnText: { color: "#fff", fontWeight: "900", letterSpacing: 0.5 },
});
