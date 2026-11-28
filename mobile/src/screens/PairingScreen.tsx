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
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Ionicons } from "@expo/vector-icons"
import { cardShadow, colorWithAlpha, radius, spacing, typeScale, useTheme } from "../theme"
import { MOBILE_TYPOGRAPHY } from "../lib/typography"
import { Button } from "../components/ui/Button"
import {
  createPairingRequest,
  fetchPairingStatus,
  formatPairingCode,
  normalizeHostInput,
  PairingStatusRequestError,
  parsePairingUri,
} from "../lib/pairing"
import { useHostStore } from "../lib/hostStore"

interface PendingPairingAttempt {
  requestId: string
  code: string
  host: string
  port: number
  deviceName: string
}

type Phase =
  | { kind: "entry" }
  | { kind: "connecting" }
  | ({ kind: "awaiting" } & PendingPairingAttempt)
  | { kind: "failed"; message: string }

const POLL_INTERVAL_MS = 2_000

function defaultDeviceName(): string {
  const os = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android" : "Mobile"
  return `MemoSync ${os}`
}

/**
 * Pairing flow: enter host:port (or scan the host settings QR) → POST a
 * pairing request → show the returned code large so it can be compared with
 * the host screen → poll sequentially every 2s → on approval persist the device
 * token in the keychain and let the root navigator switch to the project list.
 */
export function PairingScreen() {
  const { colors, dark } = useTheme()
  const insets = useSafeAreaInsets()
  const pair = useHostStore((s) => s.pair)

  const [hostInput, setHostInput] = useState("")
  const [portInput, setPortInput] = useState("")
  const [deviceName, setDeviceName] = useState(defaultDeviceName())
  const [phase, setPhase] = useState<Phase>({ kind: "entry" })
  const [resumableAttempt, setResumableAttempt] = useState<PendingPairingAttempt | null>(null)
  const [scanning, setScanning] = useState(false)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const scanLock = useRef(false)
  const lastPendingAttemptRef = useRef<PendingPairingAttempt | null>(null)

  const handleHostChange = useCallback((value: string) => {
    const parsedUri = parsePairingUri(value)
    if (parsedUri) {
      setHostInput(parsedUri.host)
      setPortInput(String(parsedUri.port))
      return
    }
    setHostInput(value)
  }, [])

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
    const resolvedName = deviceName.trim() || defaultDeviceName()
    setHostInput(target.host)
    setPortInput(String(target.port))
    setPhase({ kind: "connecting" })

    // The host enforces a 2-pending-requests-per-IP cap over a 10-minute TTL
    // with no unauthenticated cancel endpoint. Reusing an already-pending
    // request for the same host/port/name avoids burning slots after Cancel.
    const previous = lastPendingAttemptRef.current
    if (
      previous &&
      previous.host === target.host &&
      previous.port === target.port &&
      previous.deviceName === resolvedName
    ) {
      try {
        const existing = await fetchPairingStatus(previous.host, previous.port, previous.requestId, previous.code)
        if (existing.status === "pending") {
          setResumableAttempt(previous)
          setPhase({ kind: "awaiting", ...previous })
          return
        }
        if (existing.status === "approved" && existing.token?.trim()) {
          lastPendingAttemptRef.current = null
          setResumableAttempt(null)
          await pair({
            host: previous.host,
            port: previous.port,
            token: existing.token,
            deviceName: previous.deviceName,
          })
          return
        }
        lastPendingAttemptRef.current = null
        setResumableAttempt(null)
      } catch {
        // Stale or unreachable — fall through and request a fresh pairing code.
      }
    }

    try {
      const { requestId, code } = await createPairingRequest(target.host, target.port, resolvedName)
      const attempt: PendingPairingAttempt = {
        requestId,
        code,
        host: target.host,
        port: target.port,
        deviceName: resolvedName,
      }
      lastPendingAttemptRef.current = attempt
      setResumableAttempt(attempt)
      setPhase({ kind: "awaiting", ...attempt })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the MemoSync host."
      setPhase({ kind: "failed", message })
    }
  }, [hostInput, portInput, deviceName, pair])

  useEffect(() => {
    if (phase.kind !== "awaiting") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearStoredAttemptIfSame = () => {
      if (lastPendingAttemptRef.current?.requestId === phase.requestId) {
        lastPendingAttemptRef.current = null
        setResumableAttempt(null)
      }
    }

    const scheduleNext = () => {
      if (cancelled) return
      timer = setTimeout(() => {
        void pollOnce()
      }, POLL_INTERVAL_MS)
    }

    const pollOnce = async () => {
      try {
        const status = await fetchPairingStatus(phase.host, phase.port, phase.requestId, phase.code)
        if (cancelled) return
        if (status.status === "approved") {
          clearStoredAttemptIfSame()
          if (!status.token?.trim()) {
            setPhase({
              kind: "failed",
              message: "The host approved pairing without returning a device credential. Start pairing again.",
            })
            return
          }
          try {
            await pair({
              host: phase.host,
              port: phase.port,
              token: status.token,
              deviceName: phase.deviceName,
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
          return
        }
        if (status.status === "denied") {
          clearStoredAttemptIfSame()
          setPhase({ kind: "failed", message: "The host denied this pairing request." })
          return
        }
        if (status.status === "expired") {
          clearStoredAttemptIfSame()
          setPhase({ kind: "failed", message: "The pairing request expired. Start a new one." })
          return
        }
        scheduleNext()
      } catch (error) {
        if (cancelled) return
        if (error instanceof PairingStatusRequestError) {
          if (error.status === 404) {
            clearStoredAttemptIfSame()
            setPhase({
              kind: "failed",
              message: "The host no longer recognizes this pairing request, usually because it restarted. Start pairing again.",
            })
            return
          }
          if (error.status === 403) {
            clearStoredAttemptIfSame()
            setPhase({
              kind: "failed",
              message: "Remote access was turned off on the MemoSync host. Enable it in MemoSync settings and try again.",
            })
            return
          }
          if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
            clearStoredAttemptIfSame()
            setPhase({
              kind: "failed",
              message: error.serverMessage || `This pairing request is no longer valid (HTTP ${error.status}). Start pairing again.`,
            })
            return
          }
        }
        // Transient network errors retry on the next sequential tick.
        scheduleNext()
      }
    }

    scheduleNext()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [phase, pair])

  const reset = useCallback(() => setPhase({ kind: "entry" }), [])
  const resumePendingCode = useCallback(() => {
    const attempt = lastPendingAttemptRef.current
    if (!attempt) return
    setDeviceName(attempt.deviceName)
    setHostInput(attempt.host)
    setPortInput(String(attempt.port))
    setPhase({ kind: "awaiting", ...attempt })
  }, [])

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
        <View style={[styles.scannerOverlay, { bottom: Math.max(insets.bottom, spacing.lg) + spacing.xl }]}>
          <Text style={styles.scannerHint}>Point at the QR code in MemoSync settings</Text>
          <Pressable onPress={() => setScanning(false)} style={({ pressed }) => [styles.scannerButton, pressed && styles.pressed]}>
            <Text style={styles.scannerButtonText}>Enter manually</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView
        style={[styles.flex, { backgroundColor: colors.background }]}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: Math.max(insets.top + spacing.lg, spacing.xxl),
            paddingBottom: Math.max(insets.bottom + spacing.lg, spacing.xxl),
          },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
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
                    onChangeText={handleHostChange}
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
                {resumableAttempt ? (
                  <Button
                    label={`Resume code ${formatPairingCode(resumableAttempt.code)}`}
                    icon="key-outline"
                    tone="secondary"
                    fullWidth
                    onPress={resumePendingCode}
                  />
                ) : null}
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
      returnKeyType="done"
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
