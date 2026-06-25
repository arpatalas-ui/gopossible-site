import React, { useCallback, useState } from "react";
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Linking,
  Platform,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { api, Stop } from "@/src/api";
import { colors } from "@/src/theme";
import { CodBadge } from "@/src/components/CodBadge";
import { StatusBadge } from "@/src/components/StatusBadge";

export default function StopScreen() {
  const { id, stopId } = useLocalSearchParams<{ id: string; stopId: string }>();
  const router = useRouter();
  const [stop, setStop] = useState<Stop | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id || !stopId) return;
    try {
      setError(null);
      const data = await api.getStop(id, stopId);
      setStop(data);
    } catch (e: any) {
      setError(e?.message || "Błąd ładowania");
    } finally {
      setLoading(false);
    }
  }, [id, stopId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const openMaps = () => {
    if (!stop) return;
    router.push(`/route/${id}/stop/${stopId}/navigate`);
  };

  const onReset = async () => {
    if (!id || !stopId) return;
    setResetting(true);
    try {
      await api.resetStop(id, stopId);
      await load();
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !stop) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error || "Nie znaleziono"}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="stop-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="back-btn">
          <Ionicons name="chevron-back" size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Stop #{stop.order}</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.statusRow}>
          <StatusBadge status={stop.status} />
        </View>

        <Text style={styles.label}>ADRES</Text>
        <Text style={styles.address} testID="stop-address">{stop.address}</Text>

        {!!stop.recipient_name && (
          <>
            <Text style={styles.label}>ODBIORCA</Text>
            <Text style={styles.recipient} testID="stop-recipient">{stop.recipient_name}</Text>
          </>
        )}

        {!!stop.phone && (
          <>
            <Text style={styles.label}>TELEFON</Text>
            <Text style={styles.recipient}>{stop.phone}</Text>
            <View style={styles.contactRow}>
              <TouchableOpacity
                style={styles.contactBtn}
                onPress={() => Linking.openURL(`tel:${stop.phone.replace(/\s+/g, "")}`)}
                testID="call-btn"
              >
                <Ionicons name="call" size={18} color="#fff" />
                <Text style={styles.contactText}>  ZADZWOŃ</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.contactBtn, styles.contactBtnAlt]}
                onPress={() => {
                  const phone = stop.phone.replace(/\s+/g, "");
                  const pkg = stop.package_numbers[0] || "";
                  const recipient = stop.recipient_name || "Pan/Pani";
                  const body = encodeURIComponent(
                    `Dzień dobry, ${recipient}. Jestem kurierem z paczką nr ${pkg}. Proszę o kontakt aby umówić dostawę.`
                  );
                  const url = Platform.select({
                    ios: `sms:${phone}&body=${body}`,
                    android: `sms:${phone}?body=${body}`,
                    default: `sms:${phone}?body=${body}`,
                  })!;
                  Linking.openURL(url).catch(() => {});
                }}
                testID="sms-btn"
              >
                <Ionicons name="chatbubble-ellipses" size={18} color={colors.text} />
                <Text style={[styles.contactText, { color: colors.text }]}>  SMS</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        <Text style={styles.label}>NUMERY PACZEK</Text>
        <View style={styles.pkgWrap}>
          {stop.package_numbers.map((p, i) => (
            <View key={i} style={styles.pkgChip}>
              <Ionicons name="cube" size={14} color={colors.text} />
              <Text style={styles.pkgText}>{p}</Text>
            </View>
          ))}
          {stop.package_numbers.length === 0 && (
            <Text style={styles.recipient}>—</Text>
          )}
        </View>

        {(stop.cod_amount > 0 || (stop.extra_fees || 0) > 0 || stop.is_cod) && (
          <View style={{ marginTop: 16 }}>
            <CodBadge amount={stop.cod_amount} fees={stop.extra_fees} isCod={stop.is_cod} large />
          </View>
        )}

        <TouchableOpacity style={styles.navBtn} onPress={openMaps} testID="navigate-btn">
          <Ionicons name="navigate" size={24} color="#fff" />
          <Text style={styles.navBtnText}>  Nawiguj</Text>
        </TouchableOpacity>

        {stop.status !== "pending" && (
          <TouchableOpacity
            style={styles.resetBtn}
            onPress={onReset}
            disabled={resetting}
            testID="reset-btn"
          >
            <Ionicons name="refresh" size={18} color={colors.text} />
            <Text style={styles.resetText}>  Cofnij status</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {stop.status === "pending" && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.absentBtn]}
            onPress={() => router.push(`/route/${id}/stop/${stopId}/absent`)}
            testID="mark-absent-btn"
          >
            <Ionicons name="person-remove" size={22} color="#fff" />
            <Text style={styles.actionText}>Nieobecny</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.deliveredBtn]}
            onPress={() => router.push(`/route/${id}/stop/${stopId}/deliver`)}
            testID="mark-delivered-btn"
          >
            <Ionicons name="checkmark-circle" size={22} color="#fff" />
            <Text style={styles.actionText}>Dostarczono</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backBtn: { padding: 8, marginRight: 4 },
  title: { flex: 1, fontSize: 22, fontWeight: "900", color: colors.text },
  scroll: { padding: 20, paddingBottom: 40 },
  statusRow: { marginBottom: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { color: colors.error, fontWeight: "700" },
  label: {
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.2,
    color: colors.textSecondary,
    marginTop: 16,
    marginBottom: 6,
  },
  address: { fontSize: 22, fontWeight: "900", color: colors.text, lineHeight: 28 },
  recipient: { fontSize: 17, color: colors.text, fontWeight: "600" },
  pkgWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pkgChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pkgText: { color: colors.text, fontWeight: "700", marginLeft: 4 },
  contactRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  contactBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  contactBtnAlt: {
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.text,
  },
  contactText: { color: "#fff", fontWeight: "900", fontSize: 13, letterSpacing: 0.5 },
  navBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.text,
    height: 56,
    borderRadius: 12,
    marginTop: 24,
  },
  navBtnText: { color: "#fff", fontSize: 15, fontWeight: "900", letterSpacing: 0.8, textTransform: "uppercase" },
  resetBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
    padding: 12,
  },
  resetText: { color: colors.text, fontWeight: "700" },
  actions: {
    flexDirection: "row",
    padding: 16,
    paddingBottom: 24,
    gap: 12,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionBtn: {
    flex: 1,
    height: 56,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  deliveredBtn: { backgroundColor: colors.success },
  absentBtn: { backgroundColor: colors.absent },
  actionText: { color: "#fff", fontSize: 14, fontWeight: "900", letterSpacing: 0.8, textTransform: "uppercase" },
});
