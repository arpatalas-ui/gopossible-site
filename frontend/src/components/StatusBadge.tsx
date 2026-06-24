import React from "react";
import { Text, View, StyleSheet } from "react-native";
import { colors } from "@/src/theme";

type Status = "pending" | "delivered" | "absent";

const LABELS: Record<Status, string> = {
  pending: "OCZEKUJE",
  delivered: "DOSTARCZONO",
  absent: "NIEOBECNY",
};

const BG: Record<Status, string> = {
  pending: "#E5E7EB",
  delivered: colors.success,
  absent: colors.absent,
};

const FG: Record<Status, string> = {
  pending: colors.text,
  delivered: colors.textInverse,
  absent: colors.textInverse,
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <View
      style={[styles.badge, { backgroundColor: BG[status] }]}
      testID={`status-badge-${status}`}
    >
      <Text style={[styles.text, { color: FG[status] }]}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  text: { fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
});
