import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import react from "@vitejs/plugin-react"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import type { ExecutableState } from "../../shared/model-access"
import type {} from "../test-fixtures/model-access-ui/fixture"

let vite: ViteDevServer
let browser: Browser
let page: Page
let url: string
const errors: string[] = []
const screenshots = join(import.meta.dir, "../../../.codex-runs/model-access-ui-v2")
beforeAll(async () => {
  vite = await createServer({
    configFile: false,
    root: join(import.meta.dir, "../test-fixtures/model-access-ui"),
    publicDir: join(import.meta.dir, "../../../public"),
    plugins: [react()],
    css: { postcss: join(import.meta.dir, "../../..") },
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  await mkdir(screenshots, { recursive: true })
})
afterEach(async () => {
  await page?.close()
  expect(errors).toEqual([])
  errors.length = 0
})
afterAll(async () => {
  await browser?.close()
  await vite?.close()
})
async function open() {
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  page.setDefaultTimeout(3000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: '{"models":[]}' }))
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname
    return host === "127.0.0.1" ? route.continue() : route.abort()
  })
  await page.goto(url)
  await page.locator('[data-engine="pi"]').getByText("Ready", { exact: true }).waitFor()
  expect(await page.title()).toBe("Model access UI fixture")
  expect(page.url()).toBe(url + "/")
  expect(await page.locator("vite-error-overlay").count()).toBe(0)
  return page
}
async function shots(name: string, prepare?: () => Promise<void>, height = 1000) {
  if (process.env.MA_UI_SKIP_SCREENSHOTS) return
  for (const theme of ["light", "dark"])
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height })
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark")
      if (prepare) {
        await page.waitForTimeout(80)
        await prepare()
      }
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)))
        console.error(
          await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
            elements: [...document.querySelectorAll("body *")]
              .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
              .slice(0, 12)
              .map((e) => ({
                tag: e.tagName,
                className: e.className,
                text: e.textContent?.slice(0, 60),
                width: e.getBoundingClientRect().width,
                right: e.getBoundingClientRect().right,
              })),
          })),
        )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({
        path: join(screenshots, `${name}-${theme}-${width}.png`),
        fullPage: !prepare,
        animations: "disabled",
      })
    }
}
async function editor(name = "Anthropic Direct") {
  const row = page.locator("[data-connection]").filter({ has: page.getByText(name, { exact: true }) })
  await row.getByRole("button", { name: "Edit", exact: true }).click()
  return page.getByRole("form", { name: "API connection", exact: true })
}
async function lastCommand() {
  return page.evaluate(() => window.modelAccessFixture.commands().at(-1))
}

test("each engine renders ready/missing/incompatible/broken across account and connection modes", async () => {
  await open()
  for (const mode of ["account", "connection"] as const)
    for (const state of ["ready", "missing", "incompatible", "broken"] as ExecutableState[]) {
      await page.evaluate(({ state, mode }) => window.modelAccessFixture.engineState(state, mode), { state, mode })
      await page
        .locator(`[data-engine="claude"][data-executable-state="${state}"][data-access-mode="${mode}"]`)
        .waitFor()
      const expected = {
        ready: "Ready",
        missing: "Executable not found.",
        incompatible: "Executable is incompatible.",
        broken: "Executable could not run.",
      }[state as "ready" | "missing" | "incompatible" | "broken"]
      for (const engine of ["claude", "codex", "pi"]) {
        const card = page.locator(`[data-engine="${engine}"]`)
        expect(await card.textContent()).toContain(expected)
        expect(await card.getByRole("button", { name: "Your sign-in", exact: true }).count()).toBe(
          engine === "pi" ? 0 : 1,
        )
        expect(await card.getByLabel("API connection", { exact: true }).count()).toBe(
          mode === "connection" || engine === "pi" ? 1 : 0,
        )
        if (mode === "connection" || engine === "pi") {
          await card.getByLabel("API connection", { exact: true }).click()
          expect(await page.locator('[role="option"][data-disabled]').count()).toBeGreaterThan(1)
          await page.keyboard.press("Escape")
        }
      }
      await shots(`engines-${state}-${mode}`)
    }
}, 30000)

test("engine paths, access, model and refresh send contract commands, with retry on rejection", async () => {
  await open()
  const card = page.locator('[data-engine="claude"]')
  await card.getByRole("button", { name: "Claude Code actions" }).click()
  await page.getByRole("button", { name: "Change path…", exact: true }).click()
  const pathDialog = page.getByRole("dialog", { name: "Change path…" })
  await pathDialog.getByLabel("Executable path override").fill("/fixture/custom/claude")
  await shots("path-dialog")
  await pathDialog.getByRole("button", { name: "Save", exact: true }).click()
  expect(await lastCommand()).toMatchObject({
    type: "modelAccess.setEngine",
    engine: "claude",
    setup: { executablePath: "/fixture/custom/claude", access: { mode: "account" } },
  })
  await card.getByRole("button", { name: "API connection", exact: true }).click()
  await card.getByRole("button", { name: "Shared model", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "custom-model", exact: true }).click()
  expect(await lastCommand()).toMatchObject({
    setup: { access: { mode: "connection", connectionId: "connection-0", defaultModel: "custom-model" } },
  })
  await card.getByRole("button", { name: "Claude Code actions" }).click()
  await page.getByRole("button", { name: "Detect again", exact: true }).click()
  expect(await lastCommand()).toEqual({ type: "modelAccess.refreshExecutables" })
  await page.evaluate(() => window.modelAccessFixture.rejectNext())
  await card.getByRole("button", { name: "Claude Code actions" }).click()
  await page.getByRole("button", { name: "Detect again", exact: true }).click()
  await card.getByRole("alert").waitFor()
  await shots("engine-command-error")
  await card.getByRole("button", { name: "Claude Code actions" }).click()
  await page.getByRole("button", { name: "Detect again", exact: true }).click()
  expect(await card.getByRole("alert").count()).toBe(0)
})

test("environment connections are read-only and test the existing connection id", async () => {
  await open()
  await page.evaluate(() => {
    const snapshot = window.modelAccessFixture.snapshot()
    snapshot.connections[0].readOnly = true
    snapshot.connections[0].keySource = "env"
    snapshot.connections[0].envKeyName = "FIXTURE_API_KEY"
    window.modelAccessFixture.publish(snapshot)
  })
  const row = page.locator('[data-connection="connection-0"]')
  expect(await row.textContent()).toContain("FIXTURE_API_KEY")
  expect(await row.getByRole("button", { name: "Delete", exact: true }).count()).toBe(0)
  expect(await row.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0)
  await row.getByRole("button", { name: "View read-only connection", exact: true }).click()
  const form = page.getByRole("form")
  expect(await form.getByLabel("Name", { exact: true }).isDisabled()).toBe(true)
  expect(await form.getByRole("button", { name: "Save", exact: true }).count()).toBe(0)
  await form.getByRole("button", { name: "Test", exact: true }).click()
  expect(await lastCommand()).toMatchObject({
    type: "modelAccess.testConnection",
    connection: { connectionId: "connection-0" },
  })
  await shots("environment-readonly")
})

test("saved keys are write-only; replace, keep and remove have distinct payloads", async () => {
  await open()
  let form = await editor()
  expect(await form.getByLabel("API key", { exact: true }).count()).toBe(0)
  await shots("key-saved")
  await form.getByRole("button", { name: "Save", exact: true }).click()
  expect(await lastCommand()).toMatchObject({ type: "modelAccess.saveConnection" })
  expect(((await lastCommand()) as any).connection.apiKey).toBeUndefined()
  form = await editor()
  await form.getByRole("button", { name: "Replace", exact: true }).click()
  await form.getByLabel("API key", { exact: true }).fill("fixture-secret")
  expect(await form.getByLabel("API key", { exact: true }).getAttribute("type")).toBe("password")
  await form.getByRole("button", { name: "Show key", exact: true }).click()
  expect(await form.getByLabel("API key", { exact: true }).getAttribute("type")).toBe("text")
  await form.getByRole("button", { name: "Hide key", exact: true }).click()
  expect(await form.getByLabel("API key", { exact: true }).getAttribute("type")).toBe("password")
  await shots("key-replace")
  await form.getByRole("button", { name: "Save", exact: true }).click()
  expect(((await lastCommand()) as any).connection.apiKey).toBe("fixture-secret")
  form = await editor()
  expect(await form.locator('input[value="fixture-secret"]').count()).toBe(0)
  await form.getByRole("button", { name: "Remove key", exact: true }).click()
  await shots("key-remove")
  await form.getByRole("button", { name: "Save", exact: true }).click()
  expect(((await lastCommand()) as any).connection.apiKey).toBeNull()
  form = await editor()
  await form.getByLabel("API key", { exact: true }).waitFor()
  await shots("key-not-saved")
})

test("preset groups/search, custom endpoints and form validation prevent invalid commands", async () => {
  await open()
  await page.getByRole("button", { name: "Add connection" }).click()
  for (const heading of ["Vendors", "Relays", "Local"])
    expect(await page.getByRole("heading", { name: heading, exact: true }).count()).toBe(1)
  await shots("presets")
  await page.getByLabel("Search providers").fill("anthropic")
  expect(await page.getByRole("button", { name: "Relay", exact: true }).count()).toBe(0)
  await shots("presets-search")
  await page.getByRole("button", { name: "Anthropic", exact: true }).click()
  let form = page.getByRole("form")
  expect(await form.getByLabel("Name", { exact: true }).inputValue()).toBe("Anthropic")
  await form.getByText("Advanced", { exact: true }).click()
  expect(await form.getByLabel("Authentication header").textContent()).toContain("x-api-key")
  expect(await form.getByRole("link", { name: "Get an API key" }).getAttribute("href")).toBe("https://example.com/keys")
  await shots("preset-form")
  await form.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Add connection" }).click()
  await page.getByRole("button", { name: "Custom endpoint" }).click()
  form = page.getByRole("form")
  const count = await page.evaluate(() => window.modelAccessFixture.commands().length)
  await form.getByRole("button", { name: "Save", exact: true }).click()
  expect(await form.getByTestId("field-error").textContent()).toContain("name")
  await form.getByLabel("Name", { exact: true }).fill("Custom")
  await form.getByLabel("Base URL", { exact: true }).fill("invalid-url")
  await form.getByRole("button", { name: "Test", exact: true }).click()
  expect(await form.getByTestId("field-error").textContent()).toContain("HTTP")
  await shots("validation-url")
  await form.getByRole("button", { name: "Remove endpoint 1" }).click()
  await form.getByRole("button", { name: "Save", exact: true }).click()
  expect(await form.getByTestId("field-error").textContent()).toContain("at least one endpoint")
  await shots("validation-endpoints")
  await form.getByRole("button", { name: "Add endpoint", exact: true }).click()
  await form.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:9999/v1/")
  await form.getByRole("button", { name: "Remove model 1" }).click()
  await form.getByRole("button", { name: "Save", exact: true }).click()
  expect(await form.getByTestId("field-error").textContent()).toContain("at least one model")
  await shots("validation-models")
  expect(await page.evaluate(() => window.modelAccessFixture.commands().length)).toBe(count)
  await form.getByRole("button", { name: "Add model", exact: true }).click()
  await form.getByLabel("Model ID", { exact: true }).fill("custom/id")
  await form.getByLabel("Context window (tokens)", { exact: true }).fill("123456")
  await form.getByRole("button", { name: "Save", exact: true }).click()
  expect(await lastCommand()).toMatchObject({
    connection: {
      name: "Custom",
      endpoints: [{ baseUrl: "http://127.0.0.1:9999/v1" }],
      models: [{ id: "custom/id", contextWindow: 123456 }],
    },
  })
}, 30000)

test("test states cover pending, success and stable error codes, and discard stale results", async () => {
  await open()
  const form = await editor()
  await page.evaluate(() => window.modelAccessFixture.holdTest(true))
  await form.getByRole("button", { name: "Test", exact: true }).click()
  await form.getByRole("button", { name: "Testing…", exact: true }).waitFor()
  await shots("test-pending")
  await page.evaluate(() => {
    window.modelAccessFixture.resolveTest()
    window.modelAccessFixture.holdTest(false)
  })
  await form.getByTestId("connection-test-result").waitFor()
  expect(await form.getByTestId("connection-test-result").textContent()).toContain("42")
  await shots("test-success")
  await page.setViewportSize({ width: 420, height: 700 })
  expect(
    await form.getByTestId("connection-test-result").evaluate((element) => {
      const result = element.getBoundingClientRect()
      const footer = element.closest("form")!.querySelector('button[type="submit"]')!.getBoundingClientRect()
      return result.top >= 0 && result.bottom <= footer.top
    }),
  ).toBe(true)
  await shots("test-success-short-height", undefined, 700)

  for (const errorCode of ["unauthorized", "not-found", "network", "model-unavailable", "unknown"]) {
    await page.evaluate(
      (errorCode) =>
        window.modelAccessFixture.testResult({
          ok: false,
          protocol: "anthropic-messages",
          errorCode,
          message: "Fixture provider detail",
        }),
      errorCode,
    )
    await form.getByRole("button", { name: "Test", exact: true }).click()
    await form.getByText("Provider details", { exact: true }).click()
    await form.getByText("Fixture provider detail", { exact: true }).waitFor()
    expect(await form.getByTestId("connection-test-result").textContent()).not.toContain("Connected")
    await shots(`test-${errorCode}`)
  }
  await page.evaluate(() => window.modelAccessFixture.holdTest(true))
  await form.getByRole("button", { name: "Test", exact: true }).click()
  await form.getByLabel("Name", { exact: true }).fill("Edited during test")
  await page.evaluate(() => window.modelAccessFixture.resolveTest())
  await form.getByRole("button", { name: "Test", exact: true }).waitFor()
  expect(await form.getByTestId("connection-test-result").count()).toBe(0)
}, 30000)

test("delete requires a dialog confirmation, cancel keeps the connection, failed save keeps the form", async () => {
  await open()
  const row = page.locator('[data-connection="connection-0"]')
  await row.getByRole("button", { name: "Delete", exact: true }).click()
  expect(
    await page.evaluate(
      () => window.modelAccessFixture.commands().filter((c) => c.type === "modelAccess.deleteConnection").length,
    ),
  ).toBe(0)
  await shots("delete-confirmation")
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
  await row.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete connection", exact: true }).click()
  expect(await lastCommand()).toEqual({ type: "modelAccess.deleteConnection", connectionId: "connection-0" })
  const form = await editor("Responses Relay")
  await page.evaluate(() => window.modelAccessFixture.rejectNext())
  await form.getByRole("button", { name: "Save", exact: true }).click()
  await form.getByRole("alert").waitFor()
  await shots("save-error")
  expect(await form.getByLabel("Name", { exact: true }).inputValue()).toBe("Responses Relay")
})

test("first run callout links to Providers and disappears as soon as an engine is ready", async () => {
  await open()
  await page.evaluate(() => window.modelAccessFixture.engineState("missing", "account"))
  await page.getByRole("link", { name: "New chat", exact: true }).click()
  await page.getByTestId("model-access-first-run").waitFor()
  await shots("first-run")
  await page.getByRole("link", { name: "Set up a model" }).click()
  await page.getByRole("button", { name: "Add connection" }).waitFor()
  await page.getByRole("link", { name: "New chat", exact: true }).click()
  await page.evaluate(() => {
    const snapshot = window.modelAccessFixture.snapshot()
    snapshot.engines.pi.ready = true
    window.modelAccessFixture.publish(snapshot)
  })
  expect(await page.getByTestId("model-access-first-run").count()).toBe(0)
  await shots("first-run-ready")
})

test("picker groups connection names and sends selected connectionId with a custom Claude model", async () => {
  await open()
  await page.evaluate(() => {
    const snapshot = window.modelAccessFixture.snapshot()
    snapshot.connections.push({ ...snapshot.connections[0], id: "second", name: "Second Anthropic" })
    window.modelAccessFixture.publish(snapshot)
    window.modelAccessFixture.clearComposer()
  })
  await page.getByRole("link", { name: "New chat", exact: true }).click()
  await page
    .locator("button")
    .filter({ has: page.locator("svg.lucide-box") })
    .first()
    .click()
  const popover = page.getByRole("dialog")
  expect(await popover.getByRole("group", { name: "Anthropic Direct", exact: true }).count()).toBe(1)
  expect(await popover.getByRole("group", { name: "Second Anthropic", exact: true }).count()).toBe(1)
  expect(await popover.getByRole("group", { name: "Responses Relay", exact: true }).count()).toBe(0)
  await shots("picker-groups")
  await popover
    .getByRole("group", { name: "Second Anthropic", exact: true })
    .getByRole("button", { name: "custom-model", exact: true })
    .click()
  expect(await page.evaluate(() => window.modelAccessFixture.composer())).toMatchObject({
    model: "custom-model",
    connectionId: "second",
  })
  await page.getByPlaceholder("Build something...").fill("fixture message")
  await page.getByPlaceholder("Build something...").press("Enter")
  const submissions = await page.evaluate(() => window.modelAccessFixture.submissions())
  expect(submissions).toMatchObject([
    { options: { provider: "claude", model: "custom-model", modelOptions: { connectionId: "second" } } },
  ])
  await shots("picker-selected")
})

test("stable readiness problems render in both access modes and localize to Chinese", async () => {
  await open()
  const expected = {
    "connection-missing": "Choose an API connection.",
    "connection-key-missing": "This connection needs an API key.",
    "connection-protocol-unsupported": "This connection does not support the engine’s native protocol.",
    "account-signed-out": "Sign in with the agent’s CLI, then refresh.",
  } as const
  for (const mode of ["account", "connection"] as const)
    for (const problem of Object.keys(expected) as (keyof typeof expected)[]) {
      await page.evaluate(({ mode, problem }) => window.modelAccessFixture.engineState("ready", mode, problem), {
        mode,
        problem,
      })
      await page.locator('[data-engine="claude"]').getByText(expected[problem], { exact: true }).waitFor()
      await shots(`problem-${problem}-${mode}`)
    }
  await page.evaluate(() => window.modelAccessFixture.language("zh-CN"))
  await page.getByRole("button", { name: "添加连接", exact: true }).waitFor()
  await shots("providers-zh-CN")
}, 30000)

test("every engine uses its configured connection default and retains effort and plan defaults", async () => {
  await open()
  await page.evaluate(() => {
    window.modelAccessFixture.engineState("ready", "connection")
    window.modelAccessFixture.clearComposer()
  })
  await page.getByRole("link", { name: "New chat", exact: true }).click()
  for (const [index, engine] of ["Claude Code", "Codex", "Pi"].entries()) {
    if (index) {
      await page.getByRole("button", { name: index === 1 ? "Claude Code" : "Codex", exact: true }).click()
      await page.getByRole("dialog").getByRole("button", { name: engine, exact: true }).click()
    }
    const input = page.getByPlaceholder("Build something...")
    await input.fill(`message for ${engine}`)
    await input.press("Enter")
    const submitted = await page.evaluate(() => window.modelAccessFixture.submissions().at(-1))
    expect(submitted).toMatchObject({
      options: {
        provider: ["claude", "codex", "pi"][index],
        model: "shared-model",
        modelOptions: { connectionId: `connection-${index}` },
      },
    })
  }
  await page.getByRole("link", { name: "Providers", exact: true }).click()
  const pi = page.locator('[data-engine="pi"]')
  await pi.getByRole("button", { name: "Medium", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "High", exact: true }).click()
  expect(await lastCommand()).toMatchObject({
    type: "settings.writeAppSettingsPatch",
    patch: { providerDefaults: { pi: { modelOptions: { reasoningEffort: "high" } } } },
  })
  await shots("defaults-preserved")
})

test("path reset, engine-specific add, selected-connection models and keyboard focus", async () => {
  await open()
  const card = page.locator('[data-engine="claude"]')
  await card.getByRole("button", { name: "Claude Code actions" }).click()
  await shots("engine-menu")
  await page.getByRole("button", { name: "Change path…", exact: true }).click()
  const pathDialog = page.getByRole("dialog", { name: "Change path…" })
  await pathDialog.getByLabel("Executable path override").fill("/tmp/override")
  await pathDialog.getByRole("button", { name: "Use automatic discovery" }).click()
  expect(await pathDialog.getByLabel("Executable path override").inputValue()).toBe("")
  await pathDialog.getByRole("button", { name: "Save", exact: true }).click()
  expect(await lastCommand()).toMatchObject({ type: "modelAccess.setEngine", setup: { executablePath: null } })
  await card.getByRole("button", { name: "API connection", exact: true }).click()
  await card.getByLabel("API connection", { exact: true }).click()
  await shots("connection-select", async () => {
    if (!(await page.getByRole("option", { name: "Add connection…", exact: true }).count()))
      await card.getByLabel("API connection", { exact: true }).click()
  })
  if (!(await page.getByRole("option", { name: "Add connection…", exact: true }).count()))
    await card.getByLabel("API connection", { exact: true }).click()
  await page.getByRole("option", { name: "Add connection…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Add connection", exact: true })
  expect(await dialog.getByRole("button", { name: "Anthropic", exact: true }).count()).toBe(1)
  expect(await dialog.getByRole("button", { name: "Relay", exact: true }).count()).toBe(0)
  await shots("presets-engine-protocol")
  await dialog.getByRole("button", { name: "Custom endpoint" }).click()
  expect(await dialog.getByLabel("Protocol 1", { exact: true }).textContent()).toContain("Anthropic")
  await shots("custom-engine-protocol")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.evaluate(() => {
    const snapshot = window.modelAccessFixture.snapshot()
    snapshot.connections.push({ ...snapshot.connections[0], id: "second", name: "Other Anthropic" })
    window.modelAccessFixture.publish(snapshot)
  })
  await card.getByRole("button", { name: "Shared model", exact: true }).click()
  expect(await page.getByRole("dialog").getByRole("group", { name: "Other Anthropic" }).count()).toBe(0)
  expect(await page.getByRole("dialog").getByRole("group", { name: "Anthropic Direct" }).count()).toBe(1)
  await page.keyboard.press("Escape")
  const actions = card.getByRole("button", { name: "Claude Code actions" })
  await actions.focus()
  await page.keyboard.press("Tab")
  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    outline: getComputedStyle(document.activeElement!).outlineStyle,
  }))
  expect(focused.tag).toBe("BUTTON")
  expect(focused.outline).toBe("solid")
  await shots("keyboard-focus")
})

test("empty connections, long names, middle-truncated paths and provider error disclosure", async () => {
  await open()
  await page.evaluate(() => {
    const snapshot = window.modelAccessFixture.snapshot()
    snapshot.connections = []
    snapshot.engines.claude.executable.path =
      "/Users/someone/Library/Application Support/very-long-install-directory/claude/bin/claude"
    window.modelAccessFixture.publish(snapshot)
  })
  await page.getByText("No API connections yet.", { exact: false }).waitFor()
  const path = page.locator('[data-engine="claude"]').locator('span[tabindex="0"]')
  await page.setViewportSize({ width: 420, height: 1000 })
  expect(await path.locator("[data-path-start]").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    true,
  )
  expect(await path.locator("[data-path-end]").textContent()).toContain("/claude")
  expect(await path.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await path.hover()
  await page.getByRole("tooltip").waitFor()
  expect(await page.getByRole("tooltip").textContent()).toContain("System PATH")
  await shots("empty-connections-path-tooltip")
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    window.modelAccessFixture.reset()
    const snapshot = window.modelAccessFixture.snapshot()
    snapshot.connections[0].name = "A long connection name that should wrap in a narrow settings column"
    snapshot.connections[0].endpoints[0].baseUrl = "https://a-very-long-api-hostname.example.com/nested/path"
    window.modelAccessFixture.publish(snapshot)
  })
  await shots("long-connection")
  const form = await editor("A long connection name that should wrap in a narrow settings column")
  await page.evaluate(() =>
    window.modelAccessFixture.testResult({
      ok: false,
      protocol: "anthropic-messages",
      errorCode: "network",
      message: "Raw provider diagnostics",
    }),
  )
  await form.getByRole("button", { name: "Test", exact: true }).click()
  await form.getByText("Provider details", { exact: true }).waitFor()
  expect(await form.getByText("Raw provider diagnostics", { exact: true }).isVisible()).toBe(false)
  await shots("test-detail-collapsed")
  await form.getByText("Provider details", { exact: true }).click()
  expect(await form.getByText("Raw provider diagnostics", { exact: true }).isVisible()).toBe(true)
})
