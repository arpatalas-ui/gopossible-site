import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Linking,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";

import { api } from "@/src/api";
import { colors } from "@/src/theme";

/**
 * QR scanner — pairs the courier app with a route generated on gopossible.pl.
 * Expected QR payload format:  `gopossible:transfer:<CODE>`  (6 chars, A-Z 0-9)
 * The screen also accepts manual code entry as a fallback when the camera is
 * unavailable (Expo web preview, no permission, etc.).
 */
export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const scannedOnce = useRef(false);

  useEffect(() => {
    // Ask once on mount on native.
    if (Platform.OS !== "web" && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const extractCode = (raw: string): string | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    // Supported payloads:
    //   gopossible:transfer:ABC234
    //   gopossible://transfer/ABC234
    //   https://gopossible.pl/transfer/ABC234
    //   ABC234 (plain code)
    const m1 = trimmed.match(/(?:gopossible[:\\/]+transfer[:\\/]+|\/transfer\/)([A-Z0-9]{4,10})/i);
    if (m1) return m1[1].toUpperCase();
    const m2 = trimmed.match(/^([A-Z0-9]{4,10})$/i);
    if (m2) return m2[1].toUpperCase();
    return null;
  };

  const claim = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { route } = await api.fetchTransfer(code);
      router.replace(`/route/${route.id}`);
    } catch (e: any) {
      setErr(e?.message || "Nie udało się pobrać trasy");
      scannedOnce.current = false;
      setBusy(false);
    }
  };

  const onBarcode = ({ data }: { data: string }) => {
    if (scannedOnce.current) return;
    const code = extractCode(data);
    if (!code) {
      setErr("Nierozpoznany kod QR. Oczekiwany format: gopossible:transfer:KOD");
      return;
    }
    scannedOnce.current = true;
    claim(code);
  };

  const onSubmitManual = () => {
    const code = extractCode(manual);
    if (!code) {
      setErr("Wpisz 6-znakowy kod z gopossible.pl (np. ABC234)");
      return;
    }
    claim(code);
  };

  const camReady = Platform.OS !== "web" && permission?.granted;

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="scan-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Skanuj kod z gopossible.pl</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.scannerArea}>
        {camReady ? (
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={busy ? undefined : onBarcode}
          />
        ) : (
          <View style={[StyleSheet.absoluteFillObject, styles.placeholder]}>
            <Ionicons name="qr-code-outline" size={120} color="rgba(255,255,255,0.4)" />
            <Text style={styles.placeholderText}>
              {Platform.OS === "web"
                ? "Skaner QR działa tylko w aplikacji mobilnej.\nUżyj ręcznego wpisania kodu poniżej."
                : permission?.canAskAgain
                  ? "Włącz dostęp do kamery, aby zeskanować kod."
                  : "Brak dostępu do kamery — otwórz Ustawienia."}
            </Text>
            {Platform.OS !== "web" && !permission?.granted && (
              <TouchableOpacity
                style={styles.permBtn}
                onPress={() => {
                  if (permission?.canAskAgain) requestPermission();
                  else Linking.openSettings();
                }}
              >
                <Text style={styles.permBtnText}>
                  {permission?.canAskAgain ? "WŁĄCZ KAMERĘ" : "OTWÓRZ USTAWIENIA"}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Aim frame overlay */}
        <View pointerEvents="none" style={styles.aimFrame}>
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
        </View>

        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.busyText}>Pobieram trasę…</Text>
          </View>
        )}
      </View>

      <View style={styles.bottom}>
        <Text style={styles.bottomLabel}>LUB WPISZ KOD RĘCZNIE</Text>
        <View style={styles.manualRow}>
          <TextInput
            value={manual}
            onChangeText={(t) => setManual(t.toUpperCase())}
            placeholder="np. ABC234"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={10}
            style={styles.input}
            testID="manual-code-input"
          />
          <TouchableOpacity
            style={[styles.submitBtn, (!manual.trim() || busy) && { opacity: 0.5 }]}
            onPress={onSubmitManual}
            disabled={!manual.trim() || busy}
            testID="manual-code-submit"
          >
            <Text style={styles.submitBtnText}>POBIERZ</Text>
          </TouchableOpacity>
        </View>
        {err && <Text style={styles.errText}>{err}</Text>}
        <Text style={styles.hint}>
          Wygeneruj kod na <Text style={{ fontWeight: "900" }}>gopossible.pl</Text> w sekcji &bdquo;Wyślij trasę&rdquo;.
          Kod ważny 24h.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 12,
    paddingVertical: 10, backgroundColor: colors.card,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center", color: colors.text, fontSize: 16, fontWeight: "900", letterSpacing: 0.5 },
  scannerArea: { flex: 1, backgroundColor: "#000", position: "relative" },
  placeholder: {
    alignItems: "center", justifyContent: "center", padding: 24, gap: 16,
    backgroundColor: "#111",
  },
  placeholderText: {
    color: "rgba(255,255,255,0.7)", fontSize: 14, textAlign: "center", lineHeight: 22, maxWidth: 320,
  },
  permBtn: {
    marginTop: 8, paddingHorizontal: 22, paddingVertical: 12,
    backgroundColor: colors.primary, borderRadius: 12,
  },
  permBtnText: { color: "#fff", fontWeight: "900", fontSize: 13, letterSpacing: 0.8 },
  aimFrame: {
    position: "absolute", left: "12%", right: "12%", top: "20%", bottom: "20%",
  },
  corner: {
    position: "absolute", width: 36, height: 36, borderColor: colors.primary, borderWidth: 4,
  },
  cornerTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0 },
  cornerTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0 },
  cornerBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0 },
  cornerBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0 },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)", gap: 12,
  },
  busyText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  bottom: {
    backgroundColor: colors.card, padding: 16, paddingBottom: 24,
    borderTopWidth: 1, borderTopColor: colors.border, gap: 10,
  },
  bottomLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  manualRow: { flexDirection: "row", gap: 10 },
  input: {
    flex: 1, height: 48, paddingHorizontal: 14,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 2,
  },
  submitBtn: {
    paddingHorizontal: 18, height: 48, borderRadius: 10,
    backgroundColor: colors.text, alignItems: "center", justifyContent: "center",
  },
  submitBtnText: { color: "#fff", fontWeight: "900", letterSpacing: 0.8 },
  errText: { color: colors.error, fontWeight: "700", fontSize: 13 },
  hint: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
});
