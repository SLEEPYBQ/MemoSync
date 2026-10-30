import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { i18n, resolveLanguage, t, useI18n } from "./index"
import { en, zhCN } from "./resources"

afterEach(() => { void i18n.changeLanguage("en") })

describe("language resolution", () => {
  test("explicit preferences ignore system languages", () => {
    expect(resolveLanguage("en", ["zh-TW"])).toBe("en")
    expect(resolveLanguage("zh-CN", ["en-US"])).toBe("zh-CN")
  })
  test("any Chinese language selects Simplified Chinese", () => {
    expect(resolveLanguage("system", ["en-US", "zh-HK"])).toBe("zh-CN")
    expect(resolveLanguage("system", ["ZH-TW"])).toBe("zh-CN")
    expect(resolveLanguage("system", ["ja-JP"])).toBe("en")
    expect(resolveLanguage("system", [])).toBe("en")
  })
})

test("resources have identical keys and interpolation variables", () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  for (const namespace of Object.keys(en) as (keyof typeof en)[]) {
    const english = en[namespace] as Record<string, string>
    const chinese = zhCN[namespace] as Record<string, string>
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
    for (const key of Object.keys(english)) {
      const variables = (value: string) => [...value.matchAll(/{{\s*([^},]+)(?:,[^}]*)?}}/g)].map((match) => match[1]).sort()
      expect(variables(chinese[key])).toEqual(variables(english[key]))
    }
  }
})

test("components render real resources in the selected language", async () => {
  function Label() { useI18n(); return <span>{t("language")}</span> }
  expect(renderToStaticMarkup(<Label />)).toBe("<span>Language</span>")
  await i18n.changeLanguage("zh-CN")
  expect(renderToStaticMarkup(<Label />)).toBe("<span>语言</span>")
})
