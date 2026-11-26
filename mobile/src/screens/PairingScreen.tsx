import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import { Ionicons } from "@expo/vector-icons"
import { cardShadow, colorWithAlpha, radius, spacing, typeScale, useTheme } from "../theme"
import { MOBILE_TYPOGRAPHY } from "../lib/typography"
import { Button } from "../components/ui/Button"
import {
  createPairingRequest,
  fetchPairingStatus,
  formatPairingCode,
  normalizeHostInput,
  parsePairingUri,
} from "../lib/pairing"
import { useHostStore } from "../lib/hostStore"

type Phase =
  | { kind: "entry" }
  | { kind: "connecting" }
  | { kind: "awaiting"; requestId: string; code: string; host: string; port: number }
  | { kind: "failed"; message: string }

const POLL_INTERVAL_MS = 2_000

function defaultDeviceName(): string {
  const os = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android" : "Mobile"
  return `MemoSync ${os}`
}

/**
 * Pairing flow: enter host:port (or scan the host settings QR) → POST a
 * pairing request → show the returned code large so it can be compared with
 * the host screen → poll every 2s → on approval persist the device token in
 * the keychain and let the root navigator switch to the project list.
 */
export function PairingScreen() {
  const { colors, dark } = useTheme()
  const pair = useHostStore((s) => s.pair)

  const [hostInput, setHostInput] = useState("")
  const [portInput, setPortInput] = useState("")
  const [deviceName, setDeviceName] = useState(defaultDeviceName())
  const [phase, setPhase] = useState<Phase>({ kind: "entry" })
  const [scanning, setScanning] = useState(false)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const scanLock = useRef(false)

  // -- QR scanning ------------------------------------------------------------

  const handleScanned = useCallback(({ data }: { data: string }) => {
    if (scanLock.current) return
    const parsed = parsePairingUri(data)
    if (!parsed) return
    scanLock.current = true
    setHostInput(String(parsed.host))
    setPortInput(String(parsed.port))
    setScanning(false)
    // Let the user confirm and tap Connect — pairing involves comparing the
    // code on both screens, so fully automatic submission is not desirable.
    setTimeout(() => {
      scanLock.current = false
    }, 1_000)
  }, [])

  const startScanning = useCallback(async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission()
      if (!result.granted) return
    }
    scanLock.current = false
    setScanning(true)
  }, [cameraPermission?.granted, requestCameraPermission])

  // -- Connect + poll -----------------------------------------------------------

  const connect = useCallback(async () => {
    const target = normalizeHostInput(hostInput, portInput)
    if (!target) {
      setPhase({ kind: "failed", message: "Enter a valid host and port, for example 192.168.1.20 and 4040." })
      return
    }
    setPhase({ kind: "connecting" })
    try {
      const { requestId, code } = await createPairingRequest(target.host, target.port, deviceName.trim() || defaultDeviceName())
      setPhase({ kind: "awaiting", requestId, code, host: target.host, port: target.port })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the MemoSync host."
      setPhase({ kind: "failed", message })
    }
  }, [hostInput, portInput, deviceName])

  useEffect(() => {
    if (phase.kind !== "awaiting") return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const status = await fetchPairingStatus(phase.host, phase.port, phase.requestId, phase.code)
        if (cancelled) return
        if (status.status === "approved" && status.token) {
          clearInterval(timer)
          try {
            await pair({
              host: phase.host,
              port: phase.port,
              token: status.token,
              deviceName: deviceName.trim() || defaultDeviceName(),
            })
            // Navigation switches automatically: the root navigator renders
            // the project screens once credentials exist.
          } catch (error) {
            if (!cancelled) {
              const detail = error instanceof Error && error.message ? ` ${error.message}` : ""
              setPhase({
                kind: "failed",
                message: `The host approved pairing, but this device could not save the credential.${detail} Start pairing again.`,
              })
            }
          }
        } else if (status.status === "denied") {
          clearInterval(timer)
          setPhase({ kind: "failed", message: "The host denied this pairing request." })
        } else if (status.status === "expired") {
          clearInterval(timer)
          setPhase({ kind: "failed", message: "The pairing request expired. Start a new one." })
        }
      } catch {
        // Transient network errors while polling are fine — the next tick retries.
      }
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [phase, pair, deviceName])

  const reset = useCallback(() => setPhase({ kind: "entry" }), [])

  // -- Render -------------------------------------------------------------------

  if (scanning) {
    return (
      <View style={styles.scannerContainer}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={handleScanned}
        />
        <View style={styles.scannerReticle} pointerEvents="none" />
        <View style={styles.scannerOverlay}>
          <Text style={styles.scannerHint}>Point at the QR code in MemoSync settings</Text>
          <Pressable onPress={() => setScanning(false)} style={({ pressed }) => [styles.scannerButton, pressed && styles.pressed]}>
            <Text style={styles.scannerButtonText}>Enter manually</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={[styles.flex, { backgroundColor: colors.background }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.inner}>
          <View style={styles.header}>
            <Image source={require("../../assets/memosync-icon.png")} style={styles.logo} resizeMode="contain" />
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: colors.foreground }]}>Connect to MemoSync</Text>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
                Pair this device with a MemoSync host on your network. Open MemoSync settings on your computer to find the pairing QR code.
              </Text>
            </View>
          </View>

          {phase.kind === "awaiting" ? (
            <View style={[styles.card, cardShadow(dark), { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardEyebrow, { color: colors.mutedForeground }]}>Pairing code</Text>
              <View style={[styles.codePanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
                <Text style={[styles.pairingCode, { color: colors.foreground }]} selectable numberOfLines={1} adjustsFontSizeToFit>
                  {formatPairingCode(phase.code)}
                </Text>
              </View>
              <Text style={[styles.awaitingHint, { color: colors.mutedForeground }]}>
                Compare this code with your computer, then approve the request there.
              </Text>
              <View style={[styles.waitingRow, { borderColor: colors.border, backgroundColor: colors.sidebar }]}> 
                <ActivityIndicator size="small" color={colors.mutedForeground} />
                <Text style={[styles.waitingText, { color: colors.mutedForeground }]}>Waiting for approval</Text>
              </View>
              <Button label="Cancel pairing" tone="text" size="compact" onPress={reset} fullWidth />
            </View>
          ) : (
            <View style={[styles.card, cardShadow(dark), { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.hostRow}>
                <View style={styles.hostField}>
                  <FieldLabel label="Host" colors={colors} />
                  <PairingInput
                    value={hostInput}
                    onChangeText={setHostInput}
                    placeholder="192.168.1.20"
                    keyboardType="url"
                    colors={colors}
                  />
                </View>
                <View style={styles.portField}>
                  <FieldLabel label="Port" colors={colors} />
                  <PairingInput
                    value={portInput}
                    onChangeText={setPortInput}
                    placeholder="4040"
                    keyboardType="number-pad"
                    colors={colors}
                  />
                </View>
              </View>

              <View>
                <FieldLabel label="Device name" colors={colors} />
                <PairingInput
                  value={deviceName}
                  onChangeText={setDeviceName}
                  placeholder={defaultDeviceName()}
                  autoCapitalize="words"
                  colors={colors}
                />
              </View>

              {phase.kind === "failed" ? (
                <View style={[styles.errorBox, { backgroundColor: colorWithAlpha(colors.destructive, dark ? 0.14 : 0.07), borderColor: colorWithAlpha(colors.destructive, 0.24) }]}>
                  <Ionicons name="warning-outline" size={16} color={colors.destructive} />
                  <Text style={[styles.errorText, { color: colors.destructive }]}>{phase.message}</Text>
                </View>
              ) : null}

              <View style={styles.actions}>
                <Button
                  label={phase.kind === "connecting" ? "Connecting…" : "Connect"}
                  icon={phase.kind === "connecting" ? undefined : "link-outline"}
                  tone="primary"
                  fullWidth
                  loading={phase.kind === "connecting"}
                  onPress={connect}
                />
                <Button label="Scan QR code" icon="scan-outline" tone="secondary" fullWidth onPress={() => void startScanning()} />
              </View>
            </View>
          )}

          <Text style={[styles.footerNote, { color: colors.mutedForeground }]}> 
            Pairing uses a one-time code and stores the device token in this phone’s secure keychain.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

type Colors = ReturnType<typeof useTheme>["colors"]

function FieldLabel({ label, colors }: { label: string; colors: Colors }) {
  return <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
}

function PairingInput(props: {
  value: string
  onChangeText: (value: string) => void
  placeholder: string
  keyboardType?: "url" | "number-pad" | "default"
  autoCapitalize?: "none" | "words"
  colors: Colors
}) {
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={props.colors.mutedIcon}
      autoCapitalize={props.autoCapitalize ?? "none"}
      autoCorrect={false}
      keyboardType={props.keyboardType ?? "default"}
      selectionColor={props.colors.focus}
      style={[
        styles.input,
        {
          borderColor: props.colors.input,
          color: props.colors.foreground,
          backgroundColor: props.colors.background,
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  pressed: {
    opacity: 0.72,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  inner: {
    width: "100%",
    maxWidth: 430,
    alignSelf: "center",
    gap: spacing.xl,
  },
  header: {
    alignItems: "center",
    gap: spacing.lg,
  },
  logo: {
    width: 62,
    height: 62,
  },
  headerText: {
    alignItems: "center",
    gap: spacing.sm,
  },
  title: {
    ...MOBILE_TYPOGRAPHY.title,
    textAlign: "center",
  },
  subtitle: {
    ...MOBILE_TYPOGRAPHY.bodySmall,
    textAlign: "center",
    maxWidth: 330,
  },
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl - 2,
    gap: spacing.lg,
  },
  cardEyebrow: {
    ...MOBILE_TYPOGRAPHY.label,
    fontWeight: "600",
    textAlign: "center",
  },
  codePanel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.lg,
  },
  pairingCode: {
    fontSize: typeScale.pairingCode.fontSize,
    lineHeight: typeScale.pairingCode.lineHeight,
    letterSpacing: typeScale.pairingCode.letterSpacing,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontWeight: "600",
    textAlign: "center",
  },
  awaitingHint: {
    ...MOBILE_TYPOGRAPHY.bodySmall,
    textAlign: "center",
  },
  waitingRow: {
    minHeight: 42,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  waitingText: {
    ...MOBILE_TYPOGRAPHY.footnote,
    fontWeight: "500",
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  hostField: {
    flex: 1,
  },
  portField: {
    width: 94,
  },
  fieldLabel: {
    ...MOBILE_TYPOGRAPHY.label,
    fontWeight: "500",
    marginBottom: spacing.xs + 1,
  },
  input: {
    minHeight: 45,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.base,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === "ios" ? spacing.sm + 2 : spacing.sm,
    fontSize: MOBILE_TYPOGRAPHY.body.fontSize,
    lineHeight: MOBILE_TYPOGRAPHY.body.lineHeight,
  },
  errorBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.base,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  errorText: {
    ...MOBILE_TYPOGRAPHY.footnote,
    flex: 1,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  footerNote: {
    ...MOBILE_TYPOGRAPHY.caption,
    textAlign: "center",
    maxWidth: 330,
    alignSelf: "center",
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  scannerReticle: {
    position: "absolute",
    alignSelf: "center",
    top: "24%",
    width: 238,
    height: 238,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.88)",
  },
  scannerOverlay: {
    position: "absolute",
    bottom: spacing.xxl * 1.7,
    left: spacing.xl,
    right: spacing.xl,
    alignItems: "center",
    gap: spacing.lg,
  },
  scannerHint: {
    color: "#fff",
    ...MOBILE_TYPOGRAPHY.bodySmall,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.65)",
    textShadowRadius: 5,
  },
  scannerButton: {
    minHeight: 44,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.32)",
  },
  scannerButtonText: {
    color: "#fff",
    ...MOBILE_TYPOGRAPHY.bodySmall,
    fontWeight: "600",
  },
})
