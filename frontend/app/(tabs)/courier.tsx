import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Modal,
  Alert,
  Platform,
  Linking,
  Share,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { api, Route } from "@/src/api";
import { useAuth } from "@/src/authContext";
import { colors } from "@/src/theme";
import { SectionLabel } from "@/src/components/SectionLabel";

type Profile = {
  name: string;
  courier_id: string;
  phone: string;
  branch: string;
};

const PROFILE_KEY = "@gopossible/courier_profile_v1";
const SETTINGS_KEY = "@gopossible/courier_settings_v1";

type Settings = { autoAdvance: boolean; gpsTracking: boolean };

const DEFAULT_PROFILE: Profile = { name: "", courier_id: "", phone: "", branch: "" };
const DEFAULT_SETTINGS: Settings = { autoAdvance: true, gpsTracking: true };

export default function CourierScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const [editing, setEditing] = useState(false);
  const [formProfile, setFormProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [savingProfile, setSavingProfile] = useState(false);

  const loadStored = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        AsyncStorage.getItem(PROFILE_KEY),
        AsyncStorage.getItem(SETTINGS_KEY),
      ]);
      if (p) setProfile({ ...DEFAULT_PROFILE, ...JSON.parse(p) });
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(s) });
    } catch {
      /* ignore */
    }
  }, []);

  const loadRoutes = useCallback(async () => {
    try {
      const data = await api.listRoutes();
      setRoutes(data);
    } catch {
      setRoutes([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadStored();
      loadRoutes();
    }, [loadStored, loadRoutes]),
  );

  /* ---------- Today's stats ---------- */
  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    let delivered = 0, absent = 0, pending = 0, cod = 0, fees = 0;
    let totalStops = 0;
    for (const r of routes) {
      if (!r.created_at?.startsWith(today)) continue;
      for (const s of r.stops || []) {
        totalStops += 1;
        if (s.status === "delivered") {
          delivered += 1;
          if (s.is_cod || (s.cod_amount || 0) > 0) cod += s.cod_amount || 0;
          fees += (s as any).extra_fees || 0;
        } else if (s.status === "absent") absent += 1;
        else pending += 1;
      }
    }
    return { delivered, absent, pending, cod, fees, totalStops, totalMoney: cod + fees };
  }, [routes]);

  /* ---------- Latest active route for "Generate PDF" ---------- */
  const latestRoute = useMemo(() => {
    if (routes.length === 0) return null;
    // Prefer the most recent approved route, fall back to most recent overall.
    const approved = routes.find((r) => r.approved_at);
    return approved || routes[0];
  }, [routes]);

  /* ---------- Profile actions ---------- */
  const openEditProfile = () => {
    setFormProfile(profile);
    setEditing(true);
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(formProfile));
      setProfile(formProfile);
      setEditing(false);
    } catch {
      Alert.alert("Błąd", "Nie udało się zapisać profilu");
    } finally {
      setSavingProfile(false);
    }
  };

  /* ---------- Settings actions ---------- */
  const toggleAutoAdvance = async () => {
    const next = { ...settings, autoAdvance: !settings.autoAdvance };
    setSettings(next);
    try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  };

  const toggleGpsTracking = async () => {
    const next = { ...settings, gpsTracking: !settings.gpsTracking };
    setSettings(next);
    try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
    // The actual GPS loop (in app/(tabs)/_layout.tsx) re-reads this key on each
    // ping, so toggling here propagates within ≤30 s without remount.
  };

  const clearLocalCache = () => {
    Alert.alert(
      "Wyczyścić dane lokalne?",
      "Usunie zapisane preferencje (profil, ustawienia). Dane tras pozostaną na serwerze.",
      [
        { text: "Anuluj", style: "cancel" },
        {
          text: "Wyczyść", style: "destructive",
          onPress: async () => {
            try {
              await AsyncStorage.multiRemove([PROFILE_KEY, SETTINGS_KEY]);
              setProfile(DEFAULT_PROFILE);
              setSettings(DEFAULT_SETTINGS);
              Alert.alert("Wyczyszczono", "Lokalne dane zostały usunięte.");
            } catch {
              Alert.alert("Błąd", "Nie udało się wyczyścić danych.");
            }
          },
        },
      ],
    );
  };

  /* ---------- PDF report ---------- */
  const downloadReport = async (routeId: string) => {
    const url = api.reportUrl(routeId, profile.name);
    try {
      if (Platform.OS === "web") {
        // Open in new tab
        // @ts-expect-error - window only exists on web
        if (typeof window !== "undefined") window.open(url, "_blank");
        return;
      }
      // Native: share the URL so user can open in browser / save
      await Share.share({ url, message: `Raport końca dnia — ${url}` });
    } catch {
      Alert.alert("Błąd", "Nie udało się otworzyć raportu. Spróbuj ponownie.");
      Linking.openURL(url).catch(() => {});
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadRoutes(); }}
            tintColor={colors.primary}
          />
        }
      >
        {/* HEADER */}
        <View style={styles.header}>
          <View style={styles.avatarWrap}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {((user?.name || profile.name).trim()[0] || "K").toUpperCase()}
              </Text>
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerName} numberOfLines={1}>
              {user?.name?.trim() || profile.name.trim() || "Kurier"}
            </Text>
            <Text style={styles.headerMeta} numberOfLines={1}>
              {user
                ? `@${user.username} • ${user.role || "kurier"}`
                : profile.branch.trim() || "Oddział nieustawiony"}
              {!user && profile.courier_id ? ` • ID ${profile.courier_id}` : ""}
            </Text>
          </View>
          <TouchableOpacity style={styles.editBtn} onPress={openEditProfile} testID="edit-profile">
            <Ionicons name="create-outline" size={18} color={colors.text} />
            <Text style={styles.editBtnText}>EDYTUJ</Text>
          </TouchableOpacity>
        </View>

        {/* STATS */}
        <View style={styles.sectionWrap}>
          <SectionLabel text="STATYSTYKI DZISIAJ" />
          <View style={styles.statsGrid}>
            <View style={[styles.statCard, { borderColor: "#A5D6A7", backgroundColor: "#E8F5E9" }]}>
              <Text style={[styles.statValue, { color: "#1B5E20" }]}>{stats.delivered}</Text>
              <Text style={styles.statLabel}>DOSTARCZONO</Text>
            </View>
            <View style={[styles.statCard, { borderColor: "#E5E7EB" }]}>
              <Text style={styles.statValue}>{stats.absent}</Text>
              <Text style={styles.statLabel}>NIEOBECNI</Text>
            </View>
            <View style={[styles.statCard, { borderColor: "#FFB300", backgroundColor: "#FFFBEB" }]}>
              <Text style={[styles.statValue, { color: "#B45309" }]}>{stats.pending}</Text>
              <Text style={styles.statLabel}>POZOSTAŁO</Text>
            </View>
          </View>
          <View style={styles.codCard}>
            <Text style={styles.codLabel}>DO ROZLICZENIA</Text>
            <Text style={styles.codValue}>{stats.totalMoney.toFixed(2)} <Text style={styles.codCurrency}>PLN</Text></Text>
            <Text style={styles.codSub}>
              COD {stats.cod.toFixed(2)} PLN  •  opłaty {stats.fees.toFixed(2)} PLN
            </Text>
          </View>
          {latestRoute && (
            <TouchableOpacity
              style={styles.reportBtn}
              onPress={() => downloadReport(latestRoute.id)}
              testID="download-report-btn"
            >
              <Ionicons name="document-text" size={22} color="#fff" />
              <Text style={styles.reportBtnText}>  GENERUJ RAPORT KOŃCA DNIA (PDF)</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* HISTORY */}
        <View style={styles.sectionWrap}>
          <SectionLabel text={`HISTORIA TRAS (${routes.length})`} />
          {routes.length === 0 ? (
            <Text style={styles.emptyText}>Brak tras. Wgraj manifest w zakładce TRASA.</Text>
          ) : (
            routes.slice(0, 10).map((r) => {
              const d = r.stops.filter((s) => s.status === "delivered").length;
              const total = r.stops.length;
              const day = (r.created_at || "").slice(0, 10);
              return (
                <View key={r.id} style={styles.historyRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.historyName} numberOfLines={1}>{r.name}</Text>
                    <Text style={styles.historyMeta}>
                      {day} • {d}/{total} dostarczono
                      {r.approved_at ? " • ✓ zatwierdzona" : ""}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.historyPdfBtn}
                    onPress={() => downloadReport(r.id)}
                    testID={`history-pdf-${r.id}`}
                  >
                    <Ionicons name="download-outline" size={16} color={colors.text} />
                    <Text style={styles.historyPdfText}>PDF</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.historyOpenBtn}
                    onPress={() => router.push(`/route/${r.id}`)}
                  >
                    <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              );
            })
          )}
        </View>

        {/* SETTINGS */}
        <View style={styles.sectionWrap}>
          <SectionLabel text="USTAWIENIA" />
          <TouchableOpacity style={styles.settingRow} onPress={toggleGpsTracking} testID="gps-toggle">
            <View style={{ flex: 1 }}>
              <Text style={styles.settingTitle}>Wysyłaj lokalizację GPS</Text>
              <Text style={styles.settingSub}>Co 30 s do gopossible.pl (gdy apka otwarta)</Text>
            </View>
            <View style={[styles.toggle, settings.gpsTracking && styles.toggleOn]}>
              <View style={[styles.toggleDot, settings.gpsTracking && styles.toggleDotOn]} />
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingRow} onPress={toggleAutoAdvance} testID="auto-advance-toggle">
            <View style={{ flex: 1 }}>
              <Text style={styles.settingTitle}>Auto-przejście do następnego stopu</Text>
              <Text style={styles.settingSub}>Po dostawie/nieobecności apka automatycznie otwiera kolejny adres</Text>
            </View>
            <View style={[styles.toggle, settings.autoAdvance && styles.toggleOn]}>
              <View style={[styles.toggleDot, settings.autoAdvance && styles.toggleDotOn]} />
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingRow} onPress={clearLocalCache}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingTitle}>Wyczyść dane lokalne</Text>
              <Text style={styles.settingSub}>Profil + ustawienia (trasy pozostają na serwerze)</Text>
            </View>
            <Ionicons name="trash-outline" size={22} color={colors.error} />
          </TouchableOpacity>
          <View style={styles.settingRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingTitle}>Wersja aplikacji</Text>
              <Text style={styles.settingSub}>GoPossible Courier 1.0.0</Text>
            </View>
          </View>
          {user && (
            <TouchableOpacity
              style={[styles.settingRow, { borderColor: colors.error }]}
              onPress={() => {
                Alert.alert(
                  "Wyloguj się?",
                  `Zostaniesz wylogowany z konta @${user.username}. Lokalne ustawienia zostaną zachowane.`,
                  [
                    { text: "Anuluj", style: "cancel" },
                    { text: "Wyloguj", style: "destructive", onPress: logout },
                  ],
                );
              }}
              testID="logout-btn"
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingTitle, { color: colors.error }]}>Wyloguj się</Text>
                <Text style={styles.settingSub}>Zalogowano jako @{user.username}</Text>
              </View>
              <Ionicons name="log-out-outline" size={22} color={colors.error} />
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* PROFILE EDIT MODAL */}
      <Modal visible={editing} animationType="slide" transparent onRequestClose={() => setEditing(false)}>
        <View style={styles.modalBackdrop}>
          <SafeAreaView style={styles.modalCard} edges={["bottom"]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Profil kuriera</Text>
              <TouchableOpacity onPress={() => setEditing(false)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalLabel}>IMIĘ I NAZWISKO</Text>
            <TextInput
              value={formProfile.name}
              onChangeText={(t) => setFormProfile((p) => ({ ...p, name: t }))}
              placeholder="Jan Kowalski"
              placeholderTextColor={colors.textSecondary}
              style={styles.modalInput}
              testID="profile-name-input"
            />
            <Text style={styles.modalLabel}>ID KURIERA</Text>
            <TextInput
              value={formProfile.courier_id}
              onChangeText={(t) => setFormProfile((p) => ({ ...p, courier_id: t }))}
              placeholder="np. K-142"
              placeholderTextColor={colors.textSecondary}
              style={styles.modalInput}
            />
            <Text style={styles.modalLabel}>TELEFON</Text>
            <TextInput
              value={formProfile.phone}
              onChangeText={(t) => setFormProfile((p) => ({ ...p, phone: t }))}
              placeholder="+48 ..."
              placeholderTextColor={colors.textSecondary}
              keyboardType="phone-pad"
              style={styles.modalInput}
            />
            <Text style={styles.modalLabel}>ODDZIAŁ</Text>
            <TextInput
              value={formProfile.branch}
              onChangeText={(t) => setFormProfile((p) => ({ ...p, branch: t }))}
              placeholder="Szczecin"
              placeholderTextColor={colors.textSecondary}
              style={styles.modalInput}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setEditing(false)}
                disabled={savingProfile}
              >
                <Text style={styles.cancelBtnText}>ANULUJ</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, savingProfile && { opacity: 0.7 }]}
                onPress={saveProfile}
                disabled={savingProfile}
                testID="save-profile"
              >
                {savingProfile ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveBtnText}>ZAPISZ</Text>
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
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 16,
    backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12,
  },
  avatarWrap: { width: 56, height: 56 },
  avatar: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: "#fff", fontWeight: "900", fontSize: 24 },
  headerName: { fontSize: 18, fontWeight: "900", color: colors.text },
  headerMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  editBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  editBtnText: { fontSize: 11, fontWeight: "900", color: colors.text, letterSpacing: 0.5 },

  sectionWrap: { paddingHorizontal: 16, marginTop: 18 },

  statsGrid: { flexDirection: "row", gap: 10, marginTop: 4 },
  statCard: {
    flex: 1, paddingVertical: 14, alignItems: "center", borderRadius: 12,
    borderWidth: 1, backgroundColor: colors.card,
  },
  statValue: { fontSize: 22, fontWeight: "900", color: colors.text },
  statLabel: { fontSize: 10, fontWeight: "900", letterSpacing: 0.5, color: colors.textSecondary, marginTop: 2 },

  codCard: {
    marginTop: 12, padding: 16, borderRadius: 14, backgroundColor: colors.text,
    boxShadow: "0px 4px 10px rgba(0,0,0,0.18)", elevation: 4,
  },
  codLabel: { color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  codValue: { color: "#fff", fontSize: 32, fontWeight: "900", marginTop: 6 },
  codCurrency: { fontSize: 18, fontWeight: "900", color: "rgba(255,255,255,0.8)" },
  codSub: { color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 6 },

  reportBtn: {
    marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, height: 52, borderRadius: 12,
    boxShadow: "0px 4px 10px rgba(230,51,41,0.25)", elevation: 3,
  },
  reportBtnText: { color: "#fff", fontWeight: "900", fontSize: 13, letterSpacing: 0.8 },

  emptyText: { color: colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: "center", paddingVertical: 18 },

  historyRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: colors.card, borderRadius: 10, marginTop: 8,
    borderWidth: 1, borderColor: colors.border, gap: 8,
  },
  historyName: { fontSize: 14, fontWeight: "900", color: colors.text },
  historyMeta: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  historyPdfBtn: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  historyPdfText: { fontSize: 11, fontWeight: "900", color: colors.text, letterSpacing: 0.4 },
  historyOpenBtn: { padding: 4 },

  settingRow: {
    flexDirection: "row", alignItems: "center",
    padding: 14, backgroundColor: colors.card, borderRadius: 10, marginTop: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  settingTitle: { fontSize: 14, fontWeight: "800", color: colors.text },
  settingSub: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  toggle: {
    width: 44, height: 26, borderRadius: 13, backgroundColor: "#D1D5DB", justifyContent: "center", padding: 3,
  },
  toggleOn: { backgroundColor: colors.primary },
  toggleDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  toggleDotOn: { transform: [{ translateX: 18 }] },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: Platform.OS === "ios" ? 0 : 18,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  modalTitle: { fontSize: 18, fontWeight: "900", color: colors.text },
  modalLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 0.8, color: colors.textSecondary, marginTop: 12, marginBottom: 4 },
  modalInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, color: colors.text,
    backgroundColor: colors.bg,
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 16, marginBottom: 4 },
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
