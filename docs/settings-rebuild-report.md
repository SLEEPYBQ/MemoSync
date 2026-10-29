# Settings rebuild — implementation and verification

Completed locally on `feat/settings-ui`, based on contract commit `81d2ed3`. No push or deployment.

## File map

| File under `src/client/app/` | Responsibility |
| --- | --- |
| `SettingsPage.tsx` | 306-line shell, responsive navigation, sign-out, connection state, footer and section routing |
| `settings/registry.ts` | Section order, stable row IDs, keybinding rows and deep-link URLs |
| `settings/shared.tsx` | Kanna grouped cards, accessory selects/actions, container-query rows, fields and notices |
| `settings/useSettingsRowHashScroll.ts` | Scroll to a row and clear its temporary highlight after 900 ms |
| `settings/GeneralSection.tsx` | Appearance, Notifications, Chats, Editor and Terminal; conditional update row |
| `settings/MemorySection.tsx` | Personal switches, preview controls, changes policy, disabled explanations and Board link |
| `settings/ProvidersSection.tsx` | DeepSeek-only default provider and model defaults |
| `settings/SkillsSection.tsx` | Existing skill search/install/uninstall behavior in grouped cards, retaining study restrictions |
| `settings/KeybindingsSection.tsx` | Shortcut drafts, persistence and restoring defaults |
| `settings/ChangelogSection.tsx` | Release cache, loading/error states, Markdown and conditional update controls |

Notification behavior lives in `app/chatNotifications.ts`, `lib/chatBrowserNotifications.ts`, and the existing App notification effect. Enter decisions are pure functions in `src/shared/submit-mode.ts`; `src/server/enqueue-and-steer.ts` adapts existing enqueue/steer methods without editing `agent.ts`.

## Kanna ports and adaptations

- `386d158`, `27406d1`, and current `settings/shared.tsx` polish: grouped cards, accessory controls and container-based responsive layouts. Replaced Kanna-specific slate/brand colors with MemoSync theme tokens. Ported its native Switch primitive, also using tokens.
- `2886889` and the current notification implementation found with `git log -S chatBrowserNotification`: opt-in permission requests, Never/When Unfocused/Always, per-chat unread/waiting transitions, initial-hydration suppression, and close/focus/open-chat on notification click. Denied/default/unsupported permission results leave the saved preference at Never.
- `ea53526`, `3e20b15`, `542572c`: Enter uses Queue/Steer; Cmd/Ctrl+Enter reverses it; an empty modified Enter invokes the existing `handleSteerQueuedMessage` for the oldest queued row. A single server enqueue request can call the existing steer path and tolerate an auto-drain race. The composer changes cover the key handler and the small option/prop plumbing it needs; draft retention, slash completion, uploads and IME handling remain intact.
- `837ee0e` → commit `85b13d4`: MemoSync has distributed copy controls rather than Kanna's `ui/copy-button.tsx`. Added one clipboard fallback and wired code/plan/landing/file-path/attachment-link/share-link copy actions to it. Copy state updates only on success.
- `4d3fc04` → commit `578250f`: replaced the upload temporary ID's direct `crypto.randomUUID()` call with existing `generateUUID()`. MemoSync has no Kanna `chat-navigation.ts` helper, so that hunk does not apply.
- `9eb757a` → commit `76e75a9`: inherit the interactive login-shell PATH alongside store startup, wait before agent resumption, retain existing PATH precedence, and use explicit updated PATH in MemoSync's `hasCommand` (there is no `resolveCommandPath`). Added missing-shell and bounded-timeout handling; a hung shell cannot stall startup indefinitely.

MemoSync-specific decisions:

- Preserve all contract field names. The Theme row only writes `appSettings.theme`; study mode hides it. No changes to `useTheme.tsx`, `src/index.css`, `agent.ts`, or memory components.
- Personal memory switches are hidden in study mode, where the condition policy remains authoritative. Preview visibility follows `conditionPolicy.preview`; the Board footer follows `boardVisible`.
- Learn From Chats and preview controls explain their disabled state when Use Memory is off. Memory Changes is also disabled while learning is off, and remains read-only until its policy has loaded.
- Keep DeepSeek-only provider filtering, existing shortcut exclusions, skill network restrictions, conditional changelog/update visibility, mobile navigation and sign-out.
- MemoSync's sidebar has no pending-question preview and its protocol has no Kanna `chat.getPreview` command. Notification bodies therefore use “Waiting for your response.” or “New chat activity.” while retaining project/chat names and chat navigation.
- As requested, keyboard submission is the focus of the composer port; send-button gestures are unchanged.

## Verification

All required checks passed on the completed implementation:

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | Pass |
| `bun test` | **2130 passed, 4 skipped, 0 failed**, 218 files, 7666 assertions |
| `bun run build:client` | Pass |
| `git diff 81d2ed3 --check` | Pass |

The four skipped tests belong to the existing opt-in Next 15 preview integration suite. The first full test attempt preceded the initial client build, so its app-shell authentication test had no built client to serve; all subsequent full runs after building passed. There are no unresolved test failures.

Added coverage includes registry uniqueness and row rendering, Memory policy/disabled states, notification permission and focus gates, per-chat event transitions, Enter/IME/attachment cases, the enqueue/steer drain race, clipboard fallback, insecure-origin UUID fallback, and login-shell PATH inheritance/timeout.

Browser verification used an isolated temporary server data directory and the actual Vite client, plus an ignored harness importing the real ChatInput component. No account login, notification permission prompt, paid model request, skill installation, or external publication was performed.

- All five available sections inspected at **1440px** and **375px**; no row or page horizontal overflow.
- General/Memory/Providers/Skills/Keybindings screenshots captured and visually inspected, including custom editor and memory-off states.
- Custom editor template, Enter mode and learning switch verified after reload.
- Invalid section redirect, deep-link scrolling, short highlight and cleanup verified in the browser.
- Actual composer tested with Enter/Ctrl+Enter/Cmd+Enter under both preferences; empty queue shortcut; attachment-only submission; IME/isComposing and Safari keyCode 229; Shift+Enter; slash completion.
- Actual browser copy fallback succeeded with `navigator.clipboard` hidden. Upload and attachment-only submission succeeded with `crypto.randomUUID` hidden and a mocked upload response; no real user project files were uploaded.
- Notification permission UI tested with denied/granted/unsupported substitutes, so no OS prompt appeared. Study-policy substitutes verified hidden Theme/personal switches; an authenticated response substitute verified mobile sign-out visibility without signing in or out.
- Runtime pages showed no application console errors. Vite development StrictMode logs its existing WebSocket close/reconnect warning; the production build reports a large-chunk advisory.

Ignored local evidence is in `output/playwright/`: screenshots, `settings-qa.log`, `composer-qa.log`, `policy-notification-qa.log`, `tsc.log`, `bun-test.log`, and `build-client.log`. The Playwright wrapper's `npx` lookup briefly stalled; verification continued with the same cached Playwright CLI executable directly.

## Local commits

1. `a9e8628` — settings architecture, controls and Memory section
2. `3fdd3e5` — application browser notifications
3. `e47929d` — configured Enter behavior and oldest queued message
4. `85b13d4` — insecure HTTP copy fix
5. `578250f` — insecure HTTP upload fix
6. `76e75a9` — login-shell PATH inheritance
