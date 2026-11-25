# MemoSync Mobile

A React Native + Expo companion app that remote-controls a MemoSync host over
LAN: browse projects and chats live, read transcripts as they stream, send and
queue messages, and interrupt running turns — all from your phone.

## Prerequisites

- A MemoSync host running on your computer with **remote access enabled**
  (MemoSync settings → sharing). The host shows a pairing QR code there.
- Phone and computer on the same network.
- Node 18+ or Bun, plus Xcode (iOS) or Android Studio (Android) for the
  simulators — or a physical device with Expo Go / a development build.

## Setup

```sh
cd mobile
bun install        # or: npm install
bunx expo start    # or: npx expo start
```

Then:

- **iOS simulator** — press `i` in the Expo CLI (requires Xcode).
- **Android emulator** — press `a` (requires Android Studio + a booted emulator).
- **Physical device** — scan the Expo CLI QR code with Expo Go. Because the app
  talks to a LAN host over plain HTTP/WebSocket, a **development build**
  (`expo run:ios` / `expo run:android`) is the reliable path; Expo Go works on
  most networks but stricter cleartext-HTTP policies on Android can require the
  dev build.

No native code is required beyond what the Expo modules ship — there is no
`ios/`/`android/` directory until you prebuild.

## Pairing flow

1. On the computer: MemoSync settings shows a QR encoding
   `memosync://pair?host=<lan-ip>&port=<port>`.
2. In the app: scan the QR (or type host + port manually) and tap **Connect**.
   The app POSTs `/api/pairing/requests` with a device name.
3. The host returns a 12-character pairing code, displayed large as
   `XXXX-XXXX-XXXX`. Compare it with the host screen and approve there.
4. The app polls `GET /api/pairing/requests/:id/status?code=<code>` every 2 s.
   On approval it receives a device token (`memosync_device_<48 hex>`), stores
   it in the OS keychain via `expo-secure-store`, and connects.
5. From then on, every API call — including the WebSocket handshake — carries
   `Authorization: Bearer <token>`.

*Attribution: the pairing-code design (grouped human-comparable code, approve
on the host) was inspired by [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
(MIT). Several small React Native UI primitives are adapted from the same MIT-licensed
project; see `THIRD_PARTY_NOTICES/MIT-T3Code` for the exact file list and license.*

## Architecture

```
src/
  App.tsx                  root: keychain hydration, socket lifecycle, navigation
  navigation.ts            stack param list
  theme.ts                 design tokens extracted from the web app's index.css
                           (light + dark, 8px radius, 13px body-ish type scale)
  types.ts                 wire protocol types, trimmed copies of the host's
                           src/shared/protocol.ts + types.ts shapes
  lib/
    hostStore.ts           zustand store; pairing credentials in expo-secure-store
    pairing.ts             pairing REST client + QR URI parsing (no URL API —
                           Hermes coverage has historically lagged)
    socket.ts              reconnecting WebSocket client (~200 lines):
                           auth headers via RN's constructor options bag,
                           command/ack promise correlation with timeouts,
                           subscription re-send on reconnect, fast-fail for
                           commands while disconnected, and an authenticated
                           status probe after close so a revoked device returns
                           to pairing instead of reconnecting forever. Module
                           singleton shared by all screens, recreated when the
                           pairing changes.
  screens/
    PairingScreen.tsx      manual host:port entry + expo-camera QR scanning
                           (degrades to manual entry when permission denied),
                           large grouped code display, 2 s status polling
    ProjectsScreen.tsx     sidebar + local-projects subscriptions, live
                           busy/idle status dots per chat
    ChatScreen.tsx         chat subscription, markdown-light transcript,
                           collapsed tool calls, replacement-style streaming
                           text, composer (chat.send when idle, message.enqueue
                           while a turn runs), Stop button, queue management
    SettingsScreen.tsx     paired host info, forget device (keychain delete)
  components/
    MarkdownLight.tsx      minimal markdown renderer — fenced code, headings,
                           lists, bold/italic/inline code; no dependency
```

### Key design decisions

- **One socket, module-owned.** The host pushes full snapshots per topic, so
  screens hold no server state of their own — they subscribe in `useEffect`
  and render the latest snapshot. The socket singleton is created when
  credentials appear and disposed when the device is forgotten.
- **Nothing is replayed across a reconnect.** Subscriptions re-send (the host
  re-pushes fresh snapshots), but in-flight commands reject instead of being
  re-delivered — a re-sent user message must be a deliberate user action.
  Failed sends restore the composer draft.
- **Streaming is replacement-style.** `runtime.streamingText` is the whole
  in-progress reply, rendered as-is; it is never appended to previous chunks,
  and the final `assistant_text` transcript entry never overlaps it.
- **Read-mostly transcript.** Memory-gate entries, system init rows and other
  host-internal transcript kinds are intentionally not rendered; user prompts,
  assistant text, collapsed tool calls and error results are.
- **Theming follows the system.** Light/dark tokens are baked hex conversions
  of the web CSS custom properties (the warm paper canvas, quiet borders,
  terracotta logo accent). System font throughout, matching the web UI.

### Type checking

```sh
bunx tsc --noEmit    # or: npx tsc --noEmit
```

## License notes

MemoSync original code is MIT, same as MemoSync. Adapted T3 Code primitives retain
their MIT copyright and are listed in `THIRD_PARTY_NOTICES/MIT-T3Code`; no T3 Code
logos, wordmarks, or brand assets are used.
