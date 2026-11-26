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
  talks to a LAN host over plain HTTP/WebSocket, the app declares Android
  cleartext-LAN access and iOS local-network access in `app.json`; use a
  trusted network or tunnel/password deployment as documented for the host.

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
    chatState.ts           pure transcript derivations shared by screens:
                           memory-gate folding + superseded-card checks,
                           effective chat status, pending-tool detection,
                           post-approval plan mode, model-selection recovery,
                           send reconciliation, retry-key & draft helpers
    draftStore.ts          per-chat composer draft + unacked-send idempotency
                           key persistence (in-memory + expo-secure-store)
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
    ChatScreen.tsx         chat subscription with load-older pagination,
                           markdown-light transcript, collapsed tool calls,
                           replacement-style streaming text, plan-mode-preserving
                           composer (chat.send when idle, message.enqueue while
                           a turn runs), Stop button, queue management
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
- **Nothing is replayed automatically; retries are idempotent.** Subscriptions
  re-send (the host re-pushes fresh snapshots), but in-flight commands reject
  instead of being re-delivered — a re-sent user message is always a deliberate
  user action. Each composer send attaches a UUID `clientRequestId` on
  `chat.send` / `message.enqueue`. In-flight send metadata is persisted
  separately from the visible draft (without duplicating the message body) and
  reconciled against the first `ChatSnapshot` on cold start so already-committed
  sends never resurrect into the composer; unacked or failed sends preserve
  their `clientRequestId` for pure retries while editing the draft or switching
  follow-up mode to `steer` mints a fresh key. Forgetting a paired host clears
  all cached and Keychain-persisted drafts.
- **Expired slash commands never absorb an existing draft.** Restoring an
  expired queued slash command fills an empty composer directly; when the
  composer already has text, the user is prompted to either replace the draft
  with the restored command, discard the expired command while keeping the
  draft, or cancel (and can also dismiss directly from the queue row).
- **Streaming is replacement-style.** `runtime.streamingText` is the whole
  in-progress reply, rendered as-is; it is never appended to previous chunks,
  and the final `assistant_text` transcript entry never overlaps it.
- **Read-mostly transcript with live memory gates.** System init rows and
  other host-internal transcript kinds are intentionally not rendered; user
  prompts, assistant text, collapsed tool calls and error results are. Memory
  preparation entries (`memory_preview`, `memory_proposals`,
  `memory_transfer`, `memory_checkup`) are interactive only when the wire state
  proves the host is still parked on them (`runtime.pendingMemoryPreviewId` for
  previews, `runtime.status === "previewing_memory"` for step-one gates): a
  parked memory preview offers "Continue with memory", "Continue without
  memory" and "Cancel message" via `chat.respondMemoryPreview`, and parked
  step-one gates offer "Skip for this message" (`chat.respondMemoryProposals` /
  `…Transfer` / `…Checkup` with `decision: "skipped"`); item-by-item curation
  stays on the host. When the host drops, restarts, or reopens a review,
  stale review cards deactivate with disabled actions and a quiet "superseded"
  notice instead of accepting dead taps. Decided or older-turn gates render
  nothing at all.
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
