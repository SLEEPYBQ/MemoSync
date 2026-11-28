import React, { type ReactNode } from "react"
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native"
import { radius, spacing, useTheme } from "../../theme"
import { MOBILE_TYPOGRAPHY } from "../../lib/typography"

/**
 * Quiet macOS-style grouped form section: white card on the paper canvas,
 * inset hairline separators, and small section chrome outside the card.
 */
export function FormSection(props: {
  readonly title?: string
  readonly footer?: string
  readonly children: ReactNode
  readonly style?: StyleProp<ViewStyle>
}) {
  const { colors } = useTheme()
  const rows = React.Children.toArray(props.children).filter(Boolean)
  return (
    <View style={[styles.section, props.style]}>
      {props.title ? (
        <Text style={[styles.title, { color: colors.sectionTitle }]} numberOfLines={1}>
          {props.title}
        </Text>
      ) : null}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {rows.map((row, index) => (
          <View
            key={index}
            style={index < rows.length - 1 ? [styles.separator, { borderBottomColor: colors.border }] : undefined}
          >
            {row}
          </View>
        ))}
      </View>
      {props.footer ? <Text style={[styles.footer, { color: colors.mutedForeground }]}>{props.footer}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  title: {
    ...MOBILE_TYPOGRAPHY.label,
    fontWeight: "600",
    marginHorizontal: spacing.sm,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  separator: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  footer: {
    ...MOBILE_TYPOGRAPHY.caption,
    marginHorizontal: spacing.sm,
  },
})
