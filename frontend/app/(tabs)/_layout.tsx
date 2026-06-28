import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/src/theme";
import { useLocationTracking } from "@/src/hooks/useLocationTracking";

export default function TabsLayout() {
  // Mount the GPS ping loop once at the tabs root so it survives screen
  // navigation between TRASA and KURIER without restarting.
  const tracking = useLocationTracking();

  const dotColor =
    tracking.status === "tracking" ? "#00B14F"
    : tracking.status === "denied" ? colors.error
    : tracking.status === "unsupported" || tracking.status === "idle" ? colors.textSecondary
    : "#FFB300";

  const label =
    tracking.status === "tracking" ? "GPS aktywny"
    : tracking.status === "denied" ? "GPS zablokowany"
    : tracking.status === "requesting-permission" ? "GPS — proszę o dostęp…"
    : tracking.status === "unsupported" ? "GPS niedostępny (web)"
    : tracking.status === "idle" ? "GPS wyłączony"
    : "GPS — błąd";

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.gpsPill} pointerEvents="none" testID="gps-pill">
        <View style={[styles.gpsDot, { backgroundColor: dotColor }]} />
        <Text style={styles.gpsLabel}>{label}</Text>
      </View>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            height: 64,
            paddingTop: 6,
            paddingBottom: 8,
          },
          tabBarLabelStyle: { fontSize: 11, fontWeight: "900", letterSpacing: 0.6 },
          tabBarItemStyle: { paddingVertical: 4 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "TRASA",
            tabBarIcon: ({ color, size }) => <Ionicons name="map" size={size ?? 24} color={color} />,
          }}
        />
        <Tabs.Screen
          name="courier"
          options={{
            title: "KURIER",
            tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" size={size ?? 24} color={color} />,
          }}
        />
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  gpsPill: {
    position: "absolute",
    top: 8,
    right: 12,
    zIndex: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(31,31,31,0.85)",
    borderRadius: 14,
  },
  gpsDot: { width: 8, height: 8, borderRadius: 4 },
  gpsLabel: { color: "#fff", fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
});
