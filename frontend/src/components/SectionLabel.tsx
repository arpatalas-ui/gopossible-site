import React from "react";
import { Text, View, StyleSheet, ViewStyle } from "react-native";
import { colors } from "@/src/theme";

// Small `// LABEL` prefix used by GoPossible for section headers.
export function SectionLabel({ text, style }: { text: string; style?: ViewStyle }) {
  return (
    <View style={[styles.row, style]}>
      <Text style={styles.slash}>// </Text>
      <Text style={styles.label}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  slash: {
    fontSize: 12,
    fontWeight: "900",
    color: colors.textSecondary,
    letterSpacing: 0.5,
  },
  label: {
    fontSize: 12,
    fontWeight: "900",
    color: colors.textSecondary,
    letterSpacing: 1.5,
  },
});
