import React from "react";
import { Text, View, StyleSheet } from "react-native";
import { colors } from "@/src/theme";

export function CodBadge({
  amount,
  fees = 0,
  isCod = false,
  large = false,
}: {
  amount: number;
  fees?: number;
  isCod?: boolean;
  large?: boolean;
}) {
  const total = (amount || 0) + (fees || 0);
  const show = total > 0 || isCod;
  if (!show) return null;
  const hasAmount = total > 0;
  return (
    <View style={[styles.badge, large && styles.large]} testID="cod-badge">
      <Text style={[styles.label, large && styles.labelLarge]}>POBRANIE</Text>
      {hasAmount ? (
        <>
          <Text style={[styles.amount, large && styles.amountLarge]}>
            {total.toFixed(2)} PLN
          </Text>
          {large && fees > 0 ? (
            <Text style={styles.breakdown}>
              {amount.toFixed(2)} + {fees.toFixed(2)} opłaty
            </Text>
          ) : null}
        </>
      ) : large ? (
        <Text style={[styles.amount, styles.amountLarge, { fontSize: 18 }]}>do pobrania</Text>
      ) : null}
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
  label: { fontSize: 10, fontWeight: "900", color: colors.text, letterSpacing: 1 },
  labelLarge: { fontSize: 13 },
  amount: { fontSize: 14, fontWeight: "900", color: colors.text, marginTop: 2 },
  amountLarge: { fontSize: 28, marginTop: 4 },
  breakdown: { fontSize: 12, color: colors.text, marginTop: 4, opacity: 0.8 },
});
