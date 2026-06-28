import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Image,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import SignatureScreen, { SignatureViewRef } from "react-native-signature-canvas";
import { Ionicons } from "@expo/vector-icons";

import { api, Stop } from "@/src/api";
import { colors } from "@/src/theme";
import { nextStopPathOrRoute } from "@/src/utils/routeFlow";

type Step = "method" | "photo-capture" | "photo-review" | "signature" | "saving";
type DeliveryMethod = "mailbox" | "door" | "neighbor" | "fence";

const METHODS: { id: DeliveryMethod; label: string; icon: keyof typeof Ionicons.glyphMap; hint: string; photoRequired: boolean }[] = [
  { id: "mailbox",  label: "Skrzynka",      icon: "mail",          hint: "Zrób zdjęcie wskazując palcem skrzynkę, do której wrzucasz paczkę", photoRequired: true },
  { id: "door",     label: "Pod drzwiami",  icon: "home",          hint: "Zrób zdjęcie paczki pozostawionej pod drzwiami",                   photoRequired: true },
  { id: "fence",    label: "Za płotem",     icon: "barbell",       hint: "Zrób zdjęcie paczki pozostawionej za płotem / w ogrodzeniu",       photoRequired: true },
  { id: "neighbor", label: "U sąsiada",     icon: "people",        hint: "Poproś sąsiada o podpis. Zdjęcie opcjonalnie",                     photoRequired: false },
];

export default function DeliverScreen() {
  const { id, stopId } = useLocalSearchParams<{ id: string; stopId: string }>();
  const router = useRouter();

  const [stop, setStop] = useState<Stop | null>(null);
  const [step, setStep] = useState<Step>("method");
  const [method, setMethod] = useState<DeliveryMethod | null>(null);
  const [photo, setPhoto] = useState<string | null>(null); // raw base64 (no prefix)
  const [error, setError] = useState<string | null>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const sigRef = useRef<SignatureViewRef | null>(null);

  const methodInfo = method ? METHODS.find((m) => m.id === method) : null;

  const loadStop = useCallback(async () => {
    if (!id || !stopId) return;
    try {
      const data = await api.getStop(id, stopId);
      setStop(data);
    } catch (e: any) {
      setError(e?.message || "Błąd");
    }
  }, [id, stopId]);

  useEffect(() => {
    loadStop();
  }, [loadStop]);

  const takePhoto = async () => {
    if (!cameraRef.current) return;
    try {
      const photoResult = await cameraRef.current.takePictureAsync({
        quality: 0.5,
        base64: true,
      });
      if (photoResult?.base64) {
        setPhoto(photoResult.base64);
        setStep("photo-review");
      }
    } catch (e: any) {
      setError(e?.message || "Nie udało się zrobić zdjęcia");
    }
  };

  const onSignatureOK = (sig: string) => {
    // sig is data:image/png;base64,...
    saveDelivery(sig);
  };

  const saveDelivery = async (sig: string | null) => {
    if (!id || !stopId) return;
    setStep("saving");
    try {
      await api.deliverStop(id, stopId, {
        photo_base64: photo || undefined,
        signature_base64: sig || undefined,
        delivery_method: method || undefined,
      });
      const nextPath = await nextStopPathOrRoute(id, stopId);
      router.replace(nextPath as Parameters<typeof router.replace>[0]);
    } catch (e: any) {
      setError(e?.message || "Nie udało się zapisać dostawy");
      setStep("signature");
    }
  };

  // ----- Render -----
  if (!stop) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          {error ? <Text style={styles.errorText}>{error}</Text> : <ActivityIndicator size="large" color={colors.primary} />}
        </View>
      </SafeAreaView>
    );
  }

  if (step === "method") {
    return (
      <SafeAreaView style={styles.container} edges={["top"]} testID="method-screen">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="close" size={28} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Gdzie zostawiasz paczkę?</Text>
          <View style={{ width: 36 }} />
        </View>
        <Text style={styles.hint}>
          Wybierz miejsce dostawy — od tego zależy, czy musisz zrobić zdjęcie.
        </Text>
        <ScrollView contentContainerStyle={styles.methodGrid}>
          {METHODS.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={styles.methodCard}
              onPress={() => {
                setMethod(m.id);
                setStep("photo-capture");
              }}
              testID={`method-${m.id}`}
            >
              <View style={styles.methodIconBox}>
                <Ionicons name={m.icon} size={28} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.methodLabel}>{m.label}</Text>
                <Text style={styles.methodHint}>
                  {m.photoRequired ? "Wymagane zdjęcie" : "Wymagany podpis sąsiada"}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (step === "saving") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.savingText}>Zapisywanie dostawy…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (step === "photo-capture") {
    if (!permission) {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        </SafeAreaView>
      );
    }
    if (!permission.granted) {
      return (
        <SafeAreaView style={styles.container} testID="camera-permission-screen">
          <View style={styles.permissionBox}>
            <Ionicons name="camera" size={64} color={colors.primary} />
            <Text style={styles.permissionTitle}>Potrzebny dostęp do aparatu</Text>
            <Text style={styles.permissionText}>
              Aby zrobić zdjęcie miejsca pozostawienia paczki, włącz aparat.
            </Text>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={requestPermission}
              testID="grant-camera-btn"
            >
              <Text style={styles.primaryBtnText}>Zezwól na aparat</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.skipBtn}
              onPress={() => {
                setPhoto(null);
                setStep("signature");
              }}
              testID="skip-photo-btn"
            >
              <Text style={styles.skipText}>Pomiń zdjęcie</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <SafeAreaView style={styles.container} edges={["top"]} testID="camera-screen">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="close" size={28} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Zrób zdjęcie</Text>
          <View style={{ width: 36 }} />
        </View>
        <Text style={styles.hint}>{methodInfo?.hint || "Zrób zdjęcie miejsca, w którym zostawiono paczkę"}</Text>
        <View style={styles.cameraWrap}>
          <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        </View>
        <View style={styles.cameraBar}>
          {!methodInfo?.photoRequired ? (
            <TouchableOpacity
              style={styles.skipBtn}
              onPress={() => {
                setPhoto(null);
                setStep("signature");
              }}
              testID="skip-photo-btn"
            >
              <Text style={styles.skipText}>Pomiń</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ width: 64 }} />
          )}
          <TouchableOpacity style={styles.shutter} onPress={takePhoto} testID="take-photo-btn">
            <View style={styles.shutterInner} />
          </TouchableOpacity>
          <View style={{ width: 64 }} />
        </View>
      </SafeAreaView>
    );
  }

  if (step === "photo-review") {
    return (
      <SafeAreaView style={styles.container} testID="photo-review-screen">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setStep("photo-capture")} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={28} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Podgląd zdjęcia</Text>
          <View style={{ width: 36 }} />
        </View>
        {photo && (
          <Image source={{ uri: `data:image/jpeg;base64,${photo}` }} style={styles.preview} />
        )}
        <View style={styles.previewActions}>
          <TouchableOpacity
            style={[styles.outlineBtn, { flex: 1 }]}
            onPress={() => {
              setPhoto(null);
              setStep("photo-capture");
            }}
            testID="retake-photo-btn"
          >
            <Text style={styles.outlineText}>Zrób ponownie</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, { flex: 1 }]}
            onPress={() => setStep("signature")}
            testID="photo-ok-btn"
          >
            <Text style={styles.primaryBtnText}>Dalej</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Signature step
  const pkgList = stop.package_numbers.join(", ") || "—";
  const confirmText =
    `Potwierdzam odebranie przesyłki nr ${pkgList} przez ${stop.recipient_name || "odbiorcę"}`;

  const sigHtml = `
.m-signature-pad { box-shadow: none; border: none; }
.m-signature-pad--body { border: 2px dashed #D1D5DB; border-radius: 12px; }
.m-signature-pad--footer { display: none; margin: 0; }
body, html { background: #F3F4F6; }
`;

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]} testID="signature-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="back-btn">
          <Ionicons name="chevron-back" size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Podpis odbiorcy</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.sigScroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.confirmText} testID="confirm-text">{confirmText}</Text>

        <View style={styles.signatureBox}>
          <SignatureScreen
            ref={sigRef}
            onOK={onSignatureOK}
            webStyle={sigHtml}
            descriptionText=""
            backgroundColor="#FFFFFF"
            penColor="#0A0A0A"
            autoClear={false}
            imageType="image/png"
          />
        </View>

        <View style={styles.sigActions}>
          <TouchableOpacity
            style={[styles.outlineBtn, { flex: 1 }]}
            onPress={() => sigRef.current?.clearSignature()}
            testID="clear-signature-btn"
          >
            <Text style={styles.outlineText}>Wyczyść</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.successBtn, { flex: 2 }]}
            onPress={() => sigRef.current?.readSignature()}
            testID="save-delivery-btn"
          >
            <Ionicons name="checkmark-circle" size={22} color="#fff" />
            <Text style={styles.successText}>  Zapisz i zakończ</Text>
          </TouchableOpacity>
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        {method !== "neighbor" && (
          <TouchableOpacity
            style={styles.skipSigBtn}
            onPress={() => saveDelivery(null)}
            testID="skip-signature-btn"
          >
            <Text style={styles.skipSigText}>POMIŃ PODPIS — zapisz dostawę bez podpisu</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backBtn: { padding: 8, marginRight: 4 },
  title: { flex: 1, fontSize: 20, fontWeight: "900", color: colors.text, textAlign: "center" },
  hint: { textAlign: "center", color: colors.textSecondary, marginBottom: 8, paddingHorizontal: 20 },
  methodGrid: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  methodCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 14, backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border, marginBottom: 4,
  },
  methodIconBox: {
    width: 48, height: 48, borderRadius: 12, backgroundColor: "#FFEBEE",
    alignItems: "center", justifyContent: "center",
  },
  methodLabel: { fontSize: 16, fontWeight: "900", color: colors.text },
  methodHint: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  skipSigBtn: { paddingVertical: 14, alignItems: "center" },
  skipSigText: { color: colors.textSecondary, fontSize: 12, fontWeight: "800", letterSpacing: 0.5, textDecorationLine: "underline" },
  cameraWrap: { flex: 1, marginHorizontal: 16, borderRadius: 16, overflow: "hidden", backgroundColor: "#000" },
  camera: { flex: 1 },
  cameraBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 20,
  },
  shutter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 4,
    borderColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.primary },
  skipBtn: { padding: 16, minWidth: 64 },
  skipText: { color: colors.textSecondary, fontWeight: "700" },
  preview: { flex: 1, margin: 16, borderRadius: 16, resizeMode: "cover" },
  previewActions: { flexDirection: "row", padding: 16, gap: 12 },
  primaryBtn: {
    backgroundColor: colors.primary,
    height: 56,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { color: "#fff", fontWeight: "900", fontSize: 14, letterSpacing: 0.8 },
  outlineBtn: {
    height: 56,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.text,
  },
  outlineText: { color: colors.text, fontWeight: "800", fontSize: 14, letterSpacing: 0.5 },
  successBtn: {
    height: 56,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success,
    flexDirection: "row",
  },
  successText: { color: "#fff", fontWeight: "900", fontSize: 14, letterSpacing: 0.8 },
  permissionBox: { flex: 1, padding: 32, alignItems: "center", justifyContent: "center" },
  permissionTitle: { fontSize: 22, fontWeight: "900", color: colors.text, marginTop: 16, textAlign: "center" },
  permissionText: { fontSize: 15, color: colors.textSecondary, marginVertical: 12, textAlign: "center" },
  sigScroll: { padding: 16, paddingBottom: 32 },
  confirmText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  signatureBox: {
    height: 280,
    marginTop: 16,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: colors.border,
  },
  sigActions: { flexDirection: "row", marginTop: 16, gap: 12 },
  errorText: { color: colors.error, fontWeight: "700", textAlign: "center", marginTop: 12 },
  savingText: { color: colors.textSecondary, marginTop: 12, fontWeight: "600" },
});
