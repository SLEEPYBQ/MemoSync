// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/components/ui/ListRow.tsx
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

import React from "react"
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout"
import { RowPressable } from "./RowPressable"
import { useTheme } from "../../theme"

function RadioIndicator({ selected }: { selected: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.radioOuter, { borderColor: selected ? colors.focus : colors.mutedIcon }]}>
      {selected ? <View style={[styles.radioInner, { backgroundColor: colors.focus }]} /> : null}
    </View>
  )
}

export function ListRow(
  props: ListRowContentProps & {
    readonly onPress: () => void
    /** Marks the row as the chosen option while it still navigates. */
    readonly selected?: boolean
    readonly accessory?: React.ReactNode
    readonly showChevron?: boolean
    readonly style?: StyleProp<ViewStyle>
    readonly tone?: "default" | "danger"
  },
) {
  const { colors } = useTheme()
  const showChevron = props.showChevron ?? true
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{
        disabled: Boolean(props.disabled),
        ...(props.selected === undefined ? {} : { checked: props.selected }),
      }}
      disabled={props.disabled}
      onPress={props.onPress}
      interactionColor={colors.accent}
      style={[{ backgroundColor: colors.card }, props.style]}
    >
      <ListRowLayout
        {...props}
        accessory={
          <View style={styles.accessoryRow}>
            {props.accessory}
            {props.selected === undefined ? null : (
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.selectionSlot}
              >
                {Platform.OS === "android" ? (
                  <RadioIndicator selected={props.selected} />
                ) : props.selected ? (
                  <Ionicons name="checkmark" size={18} color={colors.focus} />
                ) : null}
              </View>
            )}
            {showChevron ? <Ionicons name="chevron-forward" size={16} color={colors.mutedIcon} /> : null}
          </View>
        }
      />
    </RowPressable>
  )
}

const styles = StyleSheet.create({
  accessoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  selectionSlot: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
})
