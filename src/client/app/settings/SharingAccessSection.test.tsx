import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AppDialogProvider } from "../../components/ui/app-dialog"
import {
  buildPairingUrl,
  buildRemoteAccessPatch,
  fetchRemoteAccessOverview,
  formatPairingCode,
  formatPairingCountdown,
  parseTimeMs,
  readRemoteAccessEnabled,
  remoteAccessApi,
  type PairedDevice,
  type PairingRequestEntry,
  type RemoteAccessStatus,
} from "../../lib/remoteAccessApi"
import { SharingAccessGroups, SharingAccessSection } from "./SharingAccessSection"
import { SETTINGS_SECTIONS, resolveSettingsSectionId } from "./registry"

const ACTIVE_STATUS: RemoteAccessStatus = {
  enabled: true,
  active: true,
  lanUrls: ["http://192.168.1.5:5175"],
}

const SAMPLE_REQUEST: PairingRequestEntry = {
  id: "req-1",
  deviceName: "Pixel 9 Pro",
  code: "abcd2348wxyz",
  createdAt: "2026-11-25T10:00:00.000Z",
  expiresAt: "2026-11-25T10:10:00.000Z",
}

const SAMPLE_DEVICE: PairedDevice = {
  id: "dev-1",
  name: "iPhone 17",
  createdAt: "2026-11-01T08:00:00.000Z",
  lastSeenAt: "2026-11-25T09:00:00.000Z",
  revokedAt: null,
}

const NOW_MS = Date.parse("2026-11-25T10:05:30.000Z")

function renderGroups(overrides: Partial<Parameters<typeof SharingAccessGroups>[0]> = {}) {
  return renderToStaticMarkup(
    <SharingAccessGroups
      enabled={false}
      status={null}
      pendingRequests={[]}
      devices={[]}
      nowMs={NOW_MS}
      onToggleEnabled={() => {}}
      onApproveRequest={() => {}}
      onDenyRequest={() => {}}
      onRevokeDevice={() => {}}
      {...overrides}
    />,
  )
}

describe("sharing section registration", () => {
  test("registers in the other group and resolves as a section id", () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === "sharing")
    expect(section).toBeDefined()
    expect(section?.group).toBe("other")
    expect(section?.label).toBe("Sharing & access")
    expect(resolveSettingsSectionId("sharing")).toBe("sharing")
  })
})

describe("SharingAccessGroups toggle", () => {
  test("renders the remote access toggle off with the security note", () => {
    const html = renderGroups()
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-label="Remote Access"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('id="remoteAccess"')
    expect(html).toContain("Only enable remote access on networks you trust.")
    // Nothing network-facing shows before the status endpoint answers.
    expect(html).not.toContain("Pair a new device")
    expect(html).not.toContain("will turn on after MemoSync restarts")
  })

  test("renders the toggle on when enabled", () => {
    const html = renderGroups({ enabled: true, status: ACTIVE_STATUS })
    expect(html).toContain('aria-checked="true"')
  })

  test("the toggle patch matches the frozen ws contract shape", () => {
    expect(buildRemoteAccessPatch(true)).toEqual({ remoteAccess: { enabled: true } })
    expect(buildRemoteAccessPatch(false)).toEqual({ remoteAccess: { enabled: false } })
  })
})

describe("restart notice", () => {
  test("shows the restart notice when enabled but not yet active", () => {
    const html = renderGroups({
      enabled: true,
      status: { enabled: true, active: false, lanUrls: [] },
    })
    expect(html).toContain("Remote access will turn on after MemoSync restarts.")
    expect(html).not.toContain("Pair a new device")
  })

  test("shows the stays-on notice when disabled but still active", () => {
    const html = renderGroups({
      enabled: false,
      status: { enabled: false, active: true, lanUrls: ["http://192.168.1.5:5175"] },
    })
    expect(html).toContain("Remote access stays on until MemoSync restarts.")
  })

  test("hides the notice once setting and bind agree", () => {
    const html = renderGroups({ enabled: true, status: ACTIVE_STATUS })
    expect(html).not.toContain("will turn on after MemoSync restarts")
    expect(html).not.toContain("until MemoSync restarts")
  })
})

describe("pairing while active", () => {
  test("renders the QR code and the copyable pairing url derived from the lan url", () => {
    const html = renderGroups({ enabled: true, status: ACTIVE_STATUS })
    expect(html).toContain("Pair a new device")
    expect(html).toContain("<svg")
    expect(html).toContain('aria-label="Pairing QR code"')
    expect(html).toContain("memosync://pair?host=192.168.1.5&amp;port=5175")
    expect(html).toContain(">Copy</button>")
    expect(html).toContain("Scan with the MemoSync app on the new device")
    expect(html).not.toContain("Other addresses")
  })

  test("renders additional lan urls as selectable copyable rows in a compact disclosure", () => {
    const html = renderGroups({
      enabled: true,
      status: {
        enabled: true,
        active: true,
        lanUrls: [
          "http://192.168.1.5:5175",
          "http://10.0.0.8:5175",
          "http://198.18.0.2:5175",
        ],
      },
    })

    expect(html).toContain("<details")
    expect(html).toContain("Other addresses")
    expect(html).toContain("http://10.0.0.8:5175")
    expect(html).toContain("http://198.18.0.2:5175")
    expect(html).toContain("select-text")
    // One copy action for the primary pairing link, plus one per alternate.
    expect(html.match(/>Copy<\/button>/g)).toHaveLength(3)
  })

  test("hides the QR row when no lan url is usable", () => {
    const html = renderGroups({ enabled: true, status: { enabled: true, active: true, lanUrls: [] } })
    expect(html).not.toContain("Pair a new device")
  })

  test("renders pending requests with a large grouped code, countdown and approve/deny actions", () => {
    const html = renderGroups({
      enabled: true,
      status: ACTIVE_STATUS,
      pendingRequests: [SAMPLE_REQUEST],
    })
    expect(html).toContain("Pixel 9 Pro")
    expect(html).toContain("ABCD-2348-WXYZ")
    expect(html).toContain("text-xl")
    expect(html).toContain("Expires in 4:30")
    expect(html).toContain(">Approve</span>")
    expect(html).toContain(">Deny</span>")
  })

  test("renders pending requests even before the lan bind is active, without the qr", () => {
    const html = renderGroups({
      enabled: true,
      status: { enabled: true, active: false, lanUrls: ["http://192.168.1.5:5175"] },
      pendingRequests: [SAMPLE_REQUEST],
    })
    expect(html).toContain("Pixel 9 Pro")
    expect(html).toContain("ABCD-2348-WXYZ")
    expect(html).not.toContain("Pair a new device")
  })

  test("disables request actions while they are in flight", () => {
    const html = renderGroups({
      enabled: true,
      status: ACTIVE_STATUS,
      pendingRequests: [SAMPLE_REQUEST],
      busyIds: new Set(["req-1"]),
    })
    expect(html.match(/<button[^>]*disabled[^>]*>/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe("paired devices", () => {
  test("renders devices with dates and a revoke action", () => {
    const html = renderGroups({ enabled: true, status: ACTIVE_STATUS, devices: [SAMPLE_DEVICE] })
    expect(html).toContain("Paired devices")
    expect(html).toContain("iPhone 17")
    expect(html).toContain("Paired")
    expect(html).toContain("Last seen")
    expect(html).toContain("2026")
    expect(html).toContain(">Revoke</span>")
    expect(html).not.toContain(">Revoked<")
  })

  test("renders a revoked device with a badge instead of the action", () => {
    const html = renderGroups({
      enabled: true,
      status: ACTIVE_STATUS,
      devices: [{ ...SAMPLE_DEVICE, revokedAt: "2026-11-20T09:00:00.000Z" }],
    })
    expect(html).toContain("Revoked")
    expect(html).not.toContain(">Revoke</span>")
  })

  test("hides the devices group when empty", () => {
    const html = renderGroups({ enabled: true, status: ACTIVE_STATUS })
    expect(html).not.toContain("Paired devices")
  })
})

describe("remote access helpers", () => {
  test("buildPairingUrl derives host and port from the first lan url", () => {
    expect(buildPairingUrl(["http://192.168.1.5:5175"])).toEqual({
      pairingUrl: "memosync://pair?host=192.168.1.5&port=5175",
      lanUrl: "http://192.168.1.5:5175",
    })
    expect(buildPairingUrl([])).toBeNull()
    expect(buildPairingUrl(["not a url"])).toBeNull()
  })

  test("formatPairingCode normalizes to grouped uppercase", () => {
    expect(formatPairingCode("abcd2348wxyz")).toBe("ABCD-2348-WXYZ")
    expect(formatPairingCode("ABCD-2348-WXYZ")).toBe("ABCD-2348-WXYZ")
    expect(formatPairingCode("ab cd 23")).toBe("ABCD-23")
  })

  test("formatPairingCountdown clamps at zero", () => {
    expect(formatPairingCountdown(270_000)).toBe("4:30")
    expect(formatPairingCountdown(61_000)).toBe("1:01")
    expect(formatPairingCountdown(0)).toBe("0:00")
    expect(formatPairingCountdown(-5_000)).toBe("0:00")
  })

  test("parseTimeMs accepts iso strings and epoch ms", () => {
    expect(parseTimeMs("2026-11-25T10:00:00.000Z")).toBe(Date.parse("2026-11-25T10:00:00.000Z"))
    expect(parseTimeMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(parseTimeMs(null)).toBeNull()
    expect(parseTimeMs("junk")).toBeNull()
  })

  test("readRemoteAccessEnabled defaults to off and reads the snapshot key", () => {
    expect(readRemoteAccessEnabled(null)).toBe(false)
    expect(readRemoteAccessEnabled(undefined)).toBe(false)
    expect(readRemoteAccessEnabled({} as never)).toBe(false)
    expect(readRemoteAccessEnabled({ remoteAccess: { enabled: true } } as never)).toBe(true)
    expect(readRemoteAccessEnabled({ remoteAccess: { enabled: false } } as never)).toBe(false)
  })
})

describe("remoteAccessApi", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(impl: (input: string, init?: RequestInit) => Response) {
    const calls: { url: string; method: string }[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? "GET" })
      return impl(url, init)
    }) as typeof fetch
    return calls
  }

  test("status, pendingRequests and devices read the contract endpoints", async () => {
    const calls = stubFetch((url) => {
      if (url === "/api/remote-access/status") return Response.json(ACTIVE_STATUS)
      if (url === "/api/pairing/pending") return Response.json({ requests: [SAMPLE_REQUEST] })
      if (url === "/api/devices") return Response.json({ devices: [SAMPLE_DEVICE] })
      return new Response("nope", { status: 404 })
    })

    expect(await remoteAccessApi.status()).toEqual(ACTIVE_STATUS)
    expect(await remoteAccessApi.pendingRequests()).toEqual({ requests: [SAMPLE_REQUEST] })
    expect(await remoteAccessApi.devices()).toEqual({ devices: [SAMPLE_DEVICE] })
    expect(calls.map((call) => call.url)).toEqual(["/api/remote-access/status", "/api/pairing/pending", "/api/devices"])
    expect(calls.every((call) => call.method === "GET")).toBe(true)
  })

  test("fetchRemoteAccessOverview reads bind state, requests and devices in one poll payload", async () => {
    const calls = stubFetch((url) => {
      if (url === "/api/remote-access/status") return Response.json(ACTIVE_STATUS)
      if (url === "/api/pairing/pending") return Response.json({ requests: [SAMPLE_REQUEST] })
      if (url === "/api/devices") return Response.json({ devices: [SAMPLE_DEVICE] })
      return new Response("nope", { status: 404 })
    })

    await expect(fetchRemoteAccessOverview()).resolves.toEqual({
      status: ACTIVE_STATUS,
      pendingRequests: [SAMPLE_REQUEST],
      devices: [SAMPLE_DEVICE],
    })
    expect(calls.map((call) => call.url)).toEqual([
      "/api/remote-access/status",
      "/api/pairing/pending",
      "/api/devices",
    ])
  })

  test("approve, deny and revoke post to the request or device url", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }))

    await remoteAccessApi.approveRequest("req-1")
    await remoteAccessApi.denyRequest("req-2")
    await remoteAccessApi.revokeDevice("dev-1")

    expect(calls).toEqual([
      { url: "/api/pairing/requests/req-1/approve", method: "POST" },
      { url: "/api/pairing/requests/req-2/deny", method: "POST" },
      { url: "/api/devices/dev-1/revoke", method: "POST" },
    ])
  })

  test("non-ok responses throw", async () => {
    stubFetch(() => new Response("nope", { status: 403 }))
    await expect(remoteAccessApi.pendingRequests()).rejects.toThrow("Request failed (403)")
  })
})

describe("SharingAccessSection container", () => {
  test("renders the toggle inside the dialog provider without crashing", () => {
    const html = renderToStaticMarkup(
      <AppDialogProvider>
        <SharingAccessSection
          state={{
            appSettings: null,
            handleWriteAppSettings: async () => {},
          }}
        />
      </AppDialogProvider>,
    )
    expect(html).toContain('aria-label="Remote Access"')
    expect(html).toContain('aria-checked="false"')
  })
})
