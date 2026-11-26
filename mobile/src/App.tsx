import React, { useEffect, useMemo } from "react"
import { ActivityIndicator, useColorScheme, View } from "react-native"
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme as NavTheme } from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { StatusBar } from "expo-status-bar"
import { darkColors, lightColors, themeForScheme } from "./theme"
import { ensurePairedSocket, useHostStore } from "./lib/hostStore"
import { teardownSocket } from "./lib/socket"
import { PairingScreen } from "./screens/PairingScreen"
import { ProjectsScreen } from "./screens/ProjectsScreen"
import { ChatScreen } from "./screens/ChatScreen"
import { SettingsScreen } from "./screens/SettingsScreen"
import type { RootStackParamList } from "./navigation"

const Stack = createNativeStackNavigator<RootStackParamList>()

function navTheme(scheme: "light" | "dark"): NavTheme {
  const base = scheme === "dark" ? DarkTheme : DefaultTheme
  const colors = scheme === "dark" ? darkColors : lightColors
  return {
    ...base,
    colors: {
      ...base.colors,
      background: colors.background,
      card: colors.sidebar, // navigation chrome sits one step back, like the web sidebar
      text: colors.foreground,
      primary: colors.focus,
      border: colors.border,
    },
  }
}

export default function App() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light"
  const theme = themeForScheme(scheme)
  const credentials = useHostStore((s) => s.credentials)
  const hydrated = useHostStore((s) => s.hydrated)
  const hydrate = useHostStore((s) => s.hydrate)

  // Load paired-host credentials out of the keychain once at boot.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Own the shared socket lifecycle at the root: it lives exactly as long as
  // the pairing does, and reconnects itself through network hiccups.
  useEffect(() => {
    if (!credentials) return
    ensurePairedSocket(credentials)
    return () => {
      // Only tear down when the pairing is gone or replaced, not on every
      // render — ensureSocket is idempotent for unchanged credentials.
      if (!useHostStore.getState().credentials) teardownSocket()
    }
  }, [credentials])

  const navigationTheme = useMemo(() => navTheme(scheme), [scheme])

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <NavigationContainer theme={navigationTheme}>
        {!hydrated ? (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.colors.background,
            }}
          >
            <ActivityIndicator color={theme.colors.mutedIcon} />
          </View>
        ) : (
          <Stack.Navigator
            screenOptions={{
              headerTintColor: theme.colors.foreground,
              headerTitleStyle: { fontSize: 17, fontWeight: "600" },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: theme.colors.background },
            }}
          >
            {!credentials ? (
              <Stack.Screen name="Pairing" component={PairingScreen} options={{ headerShown: false }} />
            ) : (
              <>
                <Stack.Screen name="Projects" component={ProjectsScreen} options={{ title: "MemoSync" }} />
                <Stack.Screen name="Chat" component={ChatScreen} />
                <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
              </>
            )}
          </Stack.Navigator>
        )}
      </NavigationContainer>
    </SafeAreaProvider>
  )
}
