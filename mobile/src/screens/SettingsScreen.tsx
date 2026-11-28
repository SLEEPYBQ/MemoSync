import React, { useEffect, useState } from "react"
import { Alert, ScrollView, StyleSheet, View } from "react-native"
import { spacing, useTheme } from "../theme"
import { useHostStore } from "../lib/hostStore"
import { getSocket, type SocketStatus } from "../lib/socket"
import { FormSection } from "../components/ui/FormSection"
import { ListRow } from "../components/ui/ListRow"
import { ListRowLayout } from "../components/ui/ListRowLayout"
import { StatusPill } from "../components/StatusPill"

function connectionCopy(status: SocketStatus): { label: string; tone: "success" | "info" | "warning" } {
  if (status === "connected") return { label: "Connected", tone: "success" }
  if (status === "connecting") return { label: "Connecting", tone: "info" }
  return { label: "Retrying", tone: "warning" }
}

/**
 * Paired-host details + forget-device. Forgetting deletes the device token
 * from the keychain; the device record on the host can be revoked separately
 * from the host's own settings.
 */
export function SettingsScreen() {
  const { colors } = useTheme()
  const credentials = useHostStore((s) => s.credentials)
  const forget = useHostStore((s) => s.forget)
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("disconnected")

  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    return socket.onStatus(setSocketStatus)
  }, [])

  const confirmForget = () => {
    Alert.alert(
      "Forget this device?",
      "The pairing token is removed from this device. To fully revoke access, also remove the device in MemoSync settings on your computer.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Forget", style: "destructive", onPress: () => void forget() },
      ],
    )
  }

  const connection = connectionCopy(socketStatus)

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <FormSection
        title="Paired host"
        footer="The device token is stored in this device’s keychain and is only ever sent to this host."
      >
        {credentials ? (
          <>
            <View>
              <ListRowLayout icon="desktop-outline" label="Host" detail={`${credentials.host}:${credentials.port}`} />
            </View>
            <View>
              <ListRowLayout icon="phone-portrait-outline" label="Device name" detail={credentials.deviceName} />
            </View>
            <View>
              <ListRowLayout
                icon="cloud-outline"
                label="Connection"
                accessory={<StatusPill label={connection.label} tone={connection.tone} size="compact" />}
              />
            </View>
          </>
        ) : (
          <View>
            <ListRowLayout icon="cloud-outline" label="No host paired" description="Pair this device from the welcome screen." />
          </View>
        )}
      </FormSection>

      <FormSection title="Access" footer="Forgetting this device does not revoke the device record on the host; remove it there too if the device is lost.">
        <ListRow
          icon="trash-outline"
          label="Forget this device"
          tone="danger"
          showChevron={false}
          onPress={confirmForget}
        />
      </FormSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.xl,
  },
})
