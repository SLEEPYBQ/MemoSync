import { afterEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { i18n } from "./index"
import { createUploadFormData } from "../components/chat-ui/ChatInput"
import { hasFileDragTypes } from "../app/ChatPage/utils"
import { ReadResultImages } from "../components/messages/ToolCallMessage"

afterEach(() => { void i18n.changeLanguage("en") })

test("Chinese UI leaves upload and drag/drop protocol field names intact", async () => {
  await i18n.changeLanguage("zh-CN")
  const file = new File(["你好"], "notes.txt")
  const form = createUploadFormData(file)
  expect((form.get("files") as File).name).toBe("notes.txt")
  expect(form.get("clientFileSizes")).toBe("6")
  expect(hasFileDragTypes(["Files"])).toBe(true)
  expect(hasFileDragTypes(["文件"])).toBe(false)
})

test("image result data stays verbatim while its accessible label localizes", async () => {
  await i18n.changeLanguage("zh-CN")
  const html = renderToStaticMarkup(<ReadResultImages images={[{ type: "image", data: "ZmFrZS1pbWFnZS1kYXRh", mimeType: "image/png" }]} />)
  expect(html).toContain("data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh")
  expect(html).toContain('alt="读取结果1"')
})
