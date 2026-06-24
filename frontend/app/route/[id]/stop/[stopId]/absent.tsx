import React, { useCallback, useEffect, useState } from "react";
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { api, Stop } from "@/src/api";
import { colors } from "@/src/theme";

const SMS_BODY =
  "Dzień dobry, jestem kurierem z paczką dla Pani/Pana. Nie zastałem nikogo pod adresem. Proszę o kontakt aby umówić ponowną dostawę.";

export default function AbsentScreen() {
  const { id, stopId } = useLocalSearchParams<{ id: string; stopId: string }>();
  const router = useRouter();
  const [stop, setStop] = useState<Stop | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id || !stopId) return;
    try {
      const data = await api.getStop(id, stopId);
      setStop(data);
    } catch (e: any) {
      setError(e?.message || "Błąd");
    }
  }, [id, stopId]);

  useEffect(() => {
    load();
  }, [load]);

  const markAbsentAndSms = async () => {
    if (!id || !stopId || !stop) return;
    setSaving(true);
    setError(null);
    try {
      await api.absentStop(id, stopId, { note: "Brak odbiorcy pod adresem" });

      const phone = (stop.phone || "").replace(/\s+/g, "");
      const body = encodeURIComponent(SMS_BODY);
      const url = Platform.select({
        ios: `sms:${phone}&body=${body}`,
        android: `sms:${phone}?body=${body}`,
        default: `sms:${phone}?body=${body}`,
      })!;

      if (phone) {
        await Linking.openURL(url).catch(() => {});
      }
      router.replace(`/route/${id}`);
    } catch (e: any) {
      setError(e?.message || "Nie udało się zapisać statusu");
    } finally {
      setSaving(false);
    }
  };

  const markAbsentOnly = async () => {
    if (!id || !stopId) return;
    setSaving(true);
    try {
      await api.absentStop(id, stopId, { note: "Brak odbiorcy pod adresem" });
      router.replace(`/route/${id}`);
    } catch (e: any) {
      setError(e?.message || "Nie udało się zapisać statusu");
    } finally {
      setSaving(false);
    }
  };

  if (!stop) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          {error ? <Text style={styles.errorText}>{error}</Text> : <ActivityIndicator color={colors.primary} />}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="absent-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="back-btn">
          <Ionicons name="chevron-back" size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Adresat nieobecny</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Ionicons name="person-remove" size={56} color={colors.absent} />
        </View>

        <Text style={styles.summaryTitle}>Brak odbiorcy</Text>
        <Text style={styles.address}>{stop.address}</Text>
        {!!stop.recipient_name && (
          <Text style={styles.recipient}>{stop.recipient_name}</Text>
        )}
        {!!stop.phone ? (
          <Text style={styles.phone}>{stop.phone}</Text>
        ) : (
          <Text style={styles.phoneMissing}>Brak numeru telefonu w manifeście</Text>
        )}

        <View style={styles.smsPreview}>
          <Text style={styles.smsLabel}>TREŚĆ SMS</Text>
          <Text style={styles.smsBody}>{SMS_BODY}</Text>
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}
      </View>

      <View style={styles.actions}>
        {!!stop.phone && (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={markAbsentAndSms}
            disabled={saving}
            testID="send-sms-btn"
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="chatbubble-ellipses" size={22} color="#fff" />
                <Text style={styles.primaryBtnText}>  Wyślij SMS: Proszę o kontakt</Text>
              </>
            )}
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.outlineBtn}
          onPress={markAbsentOnly}
          disabled={saving}
          testID="back-to-route-btn"
        >
          <Text style={styles.outlineText}>
            {stop.phone ? "Zapisz bez SMS" : "Oznacz jako nieobecny"}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 },
  backBtn: { padding: 8, marginRight: 4 },
  title: { flex: 1, fontSize: 20, fontWeight: "900", color: colors.text, textAlign: "center" },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 8, alignItems: "center" },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#F0F0F0",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 16,
  },
  summaryTitle: { fontSize: 22, fontWeight: "900", color: colors.text, marginBottom: 8 },
  address: { fontSize: 16, fontWeight: "700", color: colors.text, textAlign: "center" },
  recipient: { fontSize: 15, color: colors.textSecondary, marginTop: 4 },
  phone: { fontSize: 18, fontWeight: "800", color: colors.text, marginTop: 8 },
  phoneMissing: { fontSize: 14, color: colors.error, marginTop: 8, fontStyle: "italic" },
  smsPreview: {
    marginTop: 20,
    alignSelf: "stretch",
    padding: 16,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  smsLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 1.2, color: colors.textSecondary, marginBottom: 6 },
  smsBody: { fontSize: 14, color: colors.text, lineHeight: 20 },
  actions: { padding: 16, paddingBottom: 24, gap: 12 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    height: 64,
    borderRadius: 999,
  },
  primaryBtnText: { color: "#fff", fontWeight: "900", fontSize: 16 },
  outlineBtn: {
    height: 56,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.text,
  },
  outlineText: { color: colors.text, fontWeight: "800", fontSize: 15 },
  errorText: { color: colors.error, fontWeight: "700", textAlign: "center", marginTop: 12 },
});
