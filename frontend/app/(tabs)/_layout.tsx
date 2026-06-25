import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/src/theme";

export default function TabsLayout() {
  return (
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
  );
}
