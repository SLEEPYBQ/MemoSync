import { expect, test } from "bun:test"
import { isKnownCatalogModel, resolveChatProviderRoute } from "./chat-providers"

test("isKnownCatalogModel covers the picker vendors and nothing else", () => {
  expect(isKnownCatalogModel("deepseek-v4-flash")).toBe(true)
  expect(isKnownCatalogModel("glm-5.3-flash")).toBe(true)
  expect(isKnownCatalogModel("claude-opus-4-8")).toBe(false)
  expect(isKnownCatalogModel("gpt-5.5")).toBe(false)
})

test("DeepSeek and own-Anthropic models take no route override", () => {
  expect(resolveChatProviderRoute("deepseek-v4-flash", {})).toBeNull()
  expect(resolveChatProviderRoute("claude-opus-4-8", {})).toBeNull()
})

test("a GLM model routes to the domestic BigModel endpoint with its own key", () => {
  const route = resolveChatProviderRoute("glm-5.3-flash", { GLM_API_KEY: "glm-key" })
  expect(route).toEqual({
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKey: "glm-key",
    autoCompactWindow: "1000000",
    subagentModel: "glm-5.3-flash",
    appendOneMillionSuffix: false,
  })
})

test("GLM_BASE_URL / GLM_AUTO_COMPACT_WINDOW / GLM_SUBAGENT_MODEL override the defaults", () => {
  const route = resolveChatProviderRoute("glm-5.3-flash", {
    GLM_API_KEY: "glm-key",
    GLM_BASE_URL: "https://api.z.ai/api/anthropic",
    GLM_AUTO_COMPACT_WINDOW: "800000",
    GLM_SUBAGENT_MODEL: "glm-4.6",
  })
  expect(route?.baseUrl).toBe("https://api.z.ai/api/anthropic")
  expect(route?.autoCompactWindow).toBe("800000")
  expect(route?.subagentModel).toBe("glm-4.6")
})

test("a GLM route with no key set yields undefined apiKey (surfaces as auth failure, not a wrong endpoint)", () => {
  const route = resolveChatProviderRoute("glm-5.3-flash", {})
  expect(route?.apiKey).toBeUndefined()
  expect(route?.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic")
})
