import React from "react";
import { Text, View, StyleSheet } from "react-native";
import { colors } from "@/src/theme";

export function CodBadge({ amount, large = false }: { amount: number; large?: boolean }) {
  if (!amount || amount <= 0) return null;
  return (
    <View
      style={[styles.badge, large && styles.large]}
      testID="cod-badge"
    >
      <Text style={[styles.label, large && styles.labelLarge]}>POBRANIE</Text>
      <Text style={[styles.amount, large && styles.amountLarge]}>
        {amount.toFixed(2)} PLN
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: colors.cod,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#E6A800",
    alignSelf: "flex-start",
  },
  large: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    alignSelf: "stretch",
    alignItems: "center",
  },
  label: {
    fontSize: 10,
    fontWeight: "900",
    color: colors.text,
    letterSpacing: 1,
  },
  labelLarge: { fontSize: 13 },
  amount: {
    fontSize: 14,
    fontWeight: "900",
    color: colors.text,
    marginTop: 2,
  },
  amountLarge: { fontSize: 28, marginTop: 4 },
});
