import { afterEach, expect, test } from "bun:test"
import { i18n, t } from "./index"
import { chatTitle, httpUiError, localizeUiResult, translateUiText } from "./uiText"

afterEach(() => { void i18n.changeLanguage("en") })

test("server errors localize by code and preserve filename parameters", async () => {
  await i18n.changeLanguage("zh-CN")
  expect(httpUiError({ error: 'File "my file-账户.txt" exceeds the 20 MB limit.', uiText: { code: "uploadFileSize", params: { v0: "my file-账户.txt", v1: 20 } } }, "fallback")).toBe("文件“my file-账户.txt”超过 20 MB 限制。")
  expect(httpUiError({ error: "ENOENT /private/tmp/my-file" }, "fallback")).toBe("ENOENT /private/tmp/my-file")
})

test("stored UI receipts switch back while arbitrary content stays verbatim", async () => {
  await i18n.changeLanguage("zh-CN")
  const receipt = t("memory:startedWithValue0Injected", { v0: 2 })
  expect(receipt).toBe("开始时注入了 2 条记忆")
  await i18n.changeLanguage("en")
  expect(translateUiText(receipt)).toBe("started with 2 injected")
  expect(translateUiText("This is a model's raw exception: check /tmp/example")).toBe("This is a model's raw exception: check /tmp/example")
})

test("plural copy and number formatting use the resolved locale", async () => {
  expect(t("memory:candidateCount", { count: 1 })).toBe("1 memory candidate")
  expect(t("memory:candidateCount", { count: 2 })).toBe("2 memory candidates")
  await i18n.changeLanguage("zh-CN")
  expect(t("memory:candidateCount", { count: 2 })).toBe("2 条候选记忆")
  expect(t("memory:candidateCount", { count: 1000 })).toBe("1,000 条候选记忆")
})

test("default title metadata never translates a user-assigned title", async () => {
  await i18n.changeLanguage("zh-CN")
  expect(chatTitle({ title: "New Chat" })).toBe("New Chat")
  expect(chatTitle({ title: "New Chat", titleUiText: { code: "newChat" } })).toBe("新建对话")
  const result = { ok: false, title: "Publish failed", uiTextFields: { title: { code: "publishFailed" as const } } }
  expect(localizeUiResult(result).title).toBe("发布失败")
  expect(result.title).toBe("Publish failed")
})
