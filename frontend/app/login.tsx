import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { useAuth } from "@/src/authContext";
import { PortalError } from "@/src/gopossible";
import { colors } from "@/src/theme";

export default function LoginScreen() {
  const { login, loading: bootLoading } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const onSubmit = async () => {
    setErr(null);
    if (!username.trim() || !password) {
      setErr("Wpisz login i hasło");
      return;
    }
    setBusy(true);
    try {
      await login(username, password);
      // Redirect handled by useAuthRedirect in _layout.tsx
    } catch (e) {
      if (e instanceof PortalError) {
        setErr(e.message);
      } else {
        setErr("Nie udało się połączyć z gopossible.pl. Sprawdź internet.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (bootLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandBox}>
            <Image
              source={require("@/assets/images/gopossible-full-logo.png")}
              style={styles.brandLogoImg}
              resizeMode="contain"
            />
            <Text style={styles.brandSub}>Aplikacja kuriera</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>LOGIN</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="person-outline" size={18} color={colors.textSecondary} />
              <TextInput
                value={username}
                onChangeText={setUsername}
                placeholder="np. testtest0gp"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                testID="login-username"
                returnKeyType="next"
                editable={!busy}
              />
            </View>

            <Text style={styles.label}>HASŁO</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.textSecondary} />
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                testID="login-password"
                returnKeyType="go"
                onSubmitEditing={onSubmit}
                editable={!busy}
              />
              <TouchableOpacity onPress={() => setShowPassword((s) => !s)} hitSlop={8}>
                <Ionicons
                  name={showPassword ? "eye-off-outline" : "eye-outline"}
                  size={18}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
            </View>

            {err && (
              <View style={styles.errBox}>
                <Ionicons name="alert-circle" size={16} color={colors.error} />
                <Text style={styles.errText}>{err}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.submitBtn, (busy || !username || !password) && { opacity: 0.55 }]}
              onPress={onSubmit}
              disabled={busy || !username || !password}
              testID="login-submit"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="log-in-outline" size={20} color="#fff" />
                  <Text style={styles.submitBtnText}>  ZALOGUJ</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <Text style={styles.footer}>
            Logujesz się przez gopossible.pl —{" "}
            <Text style={{ fontWeight: "900" }}>te same dane co na portalu dyspozytora</Text>.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: 24, paddingTop: 40, paddingBottom: 24, minHeight: "100%" },
  brandBox: { alignItems: "center", marginBottom: 28 },
  brandLogoImg: {
    width: 280,
    height: 75,
    marginBottom: 6,
  },
  brandSub: { fontSize: 13, color: colors.textSecondary, marginTop: 4, letterSpacing: 0.4 },
  card: {
    backgroundColor: colors.card, padding: 20, borderRadius: 16,
    borderWidth: 1, borderColor: colors.border,
    boxShadow: "0px 4px 14px rgba(0,0,0,0.04)", elevation: 2,
  },
  label: { fontSize: 11, fontWeight: "900", letterSpacing: 1, color: colors.textSecondary, marginTop: 8, marginBottom: 6 },
  inputWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: Platform.OS === "ios" ? 12 : 8,
  },
  input: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 4 },
  errBox: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#FFEBEE", borderWidth: 1, borderColor: "#FFCDD2", borderRadius: 10,
    padding: 10, marginTop: 14,
  },
  errText: { color: colors.error, fontSize: 12, fontWeight: "700", flex: 1 },
  submitBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, height: 52, borderRadius: 12, marginTop: 18,
    boxShadow: "0px 4px 10px rgba(230,51,41,0.28)", elevation: 3,
  },
  submitBtnText: { color: "#fff", fontWeight: "900", fontSize: 15, letterSpacing: 0.7 },
  footer: { marginTop: 24, textAlign: "center", color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
});

// (logo image bundled from assets/images/gopossible-logo.png)
