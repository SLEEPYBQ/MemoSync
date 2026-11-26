import * as SecureStore from "expo-secure-store"
import { create } from "zustand"
import type { PairingCredentials } from "../types"
import { validateDeviceToken } from "./pairing"
import { ensureSocket, teardownSocket } from "./socket"

/**
 * Paired-host credentials, persisted in the OS keychain/keystore via
 * expo-secure-store. The device token is a bearer credential for the LAN
 * host — it must never hit logs or plaintext storage.
 */

const SECURE_STORE_KEY = "memosync.pairing"
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

/** Drop only the exact pairing whose token was revoked. A late probe from an
 * older socket must not erase a newer pairing that happens to be in flight. */
function forgetIfCurrentToken(token: string) {
  const state = useHostStore.getState()
  if (state.credentials?.token !== token) return
  void state.forget()
}

export function ensurePairedSocket(credentials: PairingCredentials) {
  return ensureSocket(credentials.host, credentials.port, credentials.token, () => forgetIfCurrentToken(credentials.token))
}

interface HostState {
  /** Null when no host is paired. Undefined-check `hydrated` before trusting. */
  credentials: PairingCredentials | null
  hydrated: boolean
  hydrate: () => Promise<void>
  pair: (credentials: PairingCredentials) => Promise<void>
  forget: () => Promise<void>
}

export const useHostStore = create<HostState>((set) => ({
  credentials: null,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await SecureStore.getItemAsync(SECURE_STORE_KEY, SECURE_STORE_OPTIONS)
      if (raw) {
        const parsed = JSON.parse(raw) as PairingCredentials
        if (parsed && typeof parsed.host === "string" && typeof parsed.port === "number" && typeof parsed.token === "string") {
          // Start the shared socket before publishing credentials. Child screens
          // subscribe in their own effects, which can run before the root
          // navigator's effect on the first paired cold start.
          ensurePairedSocket(parsed)
          set({ credentials: parsed, hydrated: true })
          // WebSocket handshake failures do not reliably expose HTTP 401 in
          // React Native, so validate a restored token once out of band. Only
          // an explicit 401 forgets it; every network failure keeps the pairing.
          void validateDeviceToken(parsed.host, parsed.port, parsed.token).then((validation) => {
            if (validation === "invalid") forgetIfCurrentToken(parsed.token)
          })
          return
        }
      }
    } catch {
      // Corrupt/unreadable entry — fall through to the unpaired state.
    }
    set({ credentials: null, hydrated: true })
  },

  pair: async (credentials) => {
    await SecureStore.setItemAsync(SECURE_STORE_KEY, JSON.stringify(credentials), SECURE_STORE_OPTIONS)
    // (Re)build the shared socket before publishing credentials so the first
    // screen's subscriptions land on an already-connecting socket.
    ensurePairedSocket(credentials)
    set({ credentials })
  },

  forget: async () => {
    teardownSocket()
    try {
      await SecureStore.deleteItemAsync(SECURE_STORE_KEY, SECURE_STORE_OPTIONS)
    } catch {
      // Keychain hiccup — still drop the in-memory credentials.
    }
    set({ credentials: null })
  },
}))
