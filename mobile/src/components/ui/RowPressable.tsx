// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/components/ui/RowPressable.tsx
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

import React, { type ComponentProps, type ReactNode } from "react"
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native"
import { useTheme } from "../../theme"

export function RowPressable({
  children,
  style,
  interactionColor,
  interactionOpacity = 1,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "style" | "android_ripple"> & {
  readonly children: ReactNode
  readonly style?: StyleProp<ViewStyle>
  readonly interactionColor?: string
  readonly interactionOpacity?: number
}) {
  const { colors } = useTheme()
  const pressedColor = interactionColor ?? colors.accent
  return (
    <Pressable
      {...props}
      android_ripple={{ color: colors.border, borderless: false }}
      unstable_pressDelay={Platform.OS === "android" ? 40 : undefined}
      style={[styles.container, style]}
    >
      {(state) => (
        <>
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: pressedColor,
                opacity: props.disabled || !state.pressed ? 0 : interactionOpacity,
              },
            ]}
          />
          {children}
        </>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
    overflow: "hidden",
  },
})
