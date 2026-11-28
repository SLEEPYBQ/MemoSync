import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { TooltipProvider } from "../ui/tooltip"
import { PROVIDERS, type ChatAttachment } from "../../../shared/types"
import { bindLandingUpload, ChatInput, composerModelOptions, createUploadFormData, getClipboardImageFiles, trimTrailingPastedNewlines, willExceedAttachmentLimit } from "./ChatInput"
import { SlashCommandMenu } from "./SlashCommandMenu"
import { isRuntimeCommandSelection, type ChatCommandCatalog } from "../../../shared/runtime-commands"
import { ListTodo } from "lucide-react"

function createClipboardItem(args: {
  kind?: string
  type: string
  file?: File | null
}) {
  return {
    kind: args.kind ?? "file",
    type: args.type,
    getAsFile: () => args.file ?? null,
  }
}

describe("native preparation options", () => {
  test("composer options are valid native preparation requests without losing connection or engine flags", () => {
    const choices = [
      { provider: "claude", model: "claude-model", modelOptions: { reasoningEffort: "high", contextWindow: "1m" }, connectionId: "example-connection", planMode: true },
      { provider: "codex", model: "codex-model", modelOptions: { reasoningEffort: "high", fastMode: true }, connectionId: "example-connection", planMode: false },
    ] as const
    for (const choice of choices) {
      const modelOptions = composerModelOptions(choice)
      expect(isRuntimeCommandSelection({ provider: choice.provider, model: choice.model, modelOptions, planMode: choice.planMode })).toBe(true)
      expect(modelOptions.connectionId).toBe("example-connection")
      expect(modelOptions[choice.provider]).toEqual(choice.modelOptions)
    }
  })
})

describe("createUploadFormData", () => {
  test("includes byte sizes for Unicode and empty files", async () => {
    for (const content of ["你好", ""]) {
      const file = new File([content], "notes.txt", { type: "text/plain" })
      const form = createUploadFormData(file)
      expect(form.getAll("clientFileSizes")).toEqual([String(new TextEncoder().encode(content).length)])
      const uploaded = form.get("files") as File
      expect(uploaded.name).toBe("notes.txt")
      expect(await uploaded.text()).toBe(content)
    }
  })
})

describe("landing upload ownership", () => {
  const upload: ChatAttachment = {
    id: "fixture-upload", kind: "file", displayName: "notes.txt", mimeType: "text/plain", size: 1,
    absolutePath: "/fixture/alpha/.memosync/uploads/notes-1.txt", relativePath: "./.memosync/uploads/notes-1.txt",
    contentUrl: "/api/projects/retired/uploads/notes-1.txt/content",
  }
  test.each(["C:\\fixture\\alpha", "\\\\fixture-host\\share\\alpha"])("retargets the stored filename under the exact Windows workspace %s", root => {
    const item = { ...upload, absolutePath: `${root}\\.memosync\\uploads\\notes-1.txt` }
    expect(bindLandingUpload(item, root, "current")).toEqual({ ...item, contentUrl: "/api/projects/current/uploads/notes-1.txt/content" })
  })
  test("rejects foreign workspaces and URLs outside the first-party upload route", () => {
    for (const overrides of [
      { absolutePath: "/fixture/beta/.memosync/uploads/notes-1.txt" },
      { relativePath: "./.memosync/uploads/other.txt" },
      { contentUrl: "https://example.invalid/api/projects/retired/uploads/notes-1.txt/content" },
      { contentUrl: "/api/projects/retired/uploads/bad%2Fname/content" },
      { contentUrl: "/api/projects/retired/uploads/notes-1.txt/content?other=workspace" },
    ]) {
      expect(bindLandingUpload({ ...upload, ...overrides }, "/fixture/alpha", "current")).toBeNull()
    }
  })
})

describe("willExceedAttachmentLimit", () => {
  test("rejects a batch that would push the composer above the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 3,
    })).toBe(true)
  })

  test("allows a batch that exactly reaches the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 2,
    })).toBe(false)
  })

  test("counts pasted files against the same total attachment limit", () => {
    const pastedFiles = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/png", file: new File(["b"], "", { type: "image/png" }) }),
    ], 123)

    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 48,
      queuedAttachmentCount: 0,
      incomingAttachmentCount: pastedFiles.length,
    })).toBe(false)
  })
})

describe("getClipboardImageFiles", () => {
  test("returns image files from clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "pasted.png", { type: "image/png" }) }),
    ], 123)

    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe("pasted.png")
  })

  test("ignores non-image clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ kind: "string", type: "text/plain" }),
      createClipboardItem({ type: "application/pdf", file: new File(["pdf"], "doc.pdf", { type: "application/pdf" }) }),
    ], 123)

    expect(files).toEqual([])
  })

  test("renames unnamed pasted images using the clipboard timestamp", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("preserves existing filenames from the browser", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/jpeg", file: new File(["img"], "Screenshot 1.jpg", { type: "image/jpeg" }) }),
    ], 456)

    expect(files[0]?.name).toBe("Screenshot 1.jpg")
  })

  test("rewrites generic browser clipboard filenames", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "image.png", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("generates distinct names for multiple unnamed images in one paste event", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/webp", file: new File(["b"], "", { type: "image/webp" }) }),
    ], 789)

    expect(files.map((file) => file.name)).toEqual([
      "clipboard-789.png",
      "clipboard-789-1.webp",
    ])
  })
})

describe("trimTrailingPastedNewlines", () => {
  test("removes trailing unix newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\n\n")).toBe("hello")
  })

  test("removes trailing windows newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\r\n\r\n")).toBe("hello")
  })

  test("preserves internal newlines", () => {
    expect(trimTrailingPastedNewlines("hello\nworld\n")).toBe("hello\nworld")
  })

  test("leaves text without trailing newlines unchanged", () => {
    expect(trimTrailingPastedNewlines("hello")).toBe("hello")
  })
})

describe("ChatInput", () => {
  test("renders the mobile attachment trigger as a native file input target", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TooltipProvider, null, createElement(ChatInput, {
      onSubmit: async () => undefined,
      disabled: false,
      canCancel: false,
      activeProvider: null,
      availableProviders: PROVIDERS,
    }))))

    expect(html).toContain('aria-label="Add attachment"')
    expect(html).toContain('type="file"')
    expect(html).toContain("absolute inset-0 cursor-pointer opacity-0")
    expect(html).not.toContain('type="file" multiple="" class="hidden"')
  })

  test("SlashCommandMenu keeps host /plan and colliding Antigravity native /native:plan distinct", () => {
    const proof = { api: "ACP session/update available_commands_update", version: "1.5.18", evidence: "native-response" as const }
    const catalog: ChatCommandCatalog = {
      runtime: { engine: "antigravity", nativeInstance: "i1", nativeSession: "s1", version: "1.5.18", profile: "p", workspace: "/w", mode: "m" },
      runtimeKey: "rk",
      revision: 1,
      commands: {
        status: "ready",
        source: proof,
        items: [{
          id: "native:plan", name: "plan", description: "Native ACP plan command", namespace: "native", owner: "native-engine",
          arguments: { type: "string" }, requiresIdle: true, sideEffect: "model-turn", route: "native-prompt", source: proof, requiredRuntimeVersion: "1.5.18",
        }],
      },
      skills: { status: "unsupported", items: [], source: proof },
      connectors: { status: "unsupported", items: [], source: proof },
      compact: { status: "unsupported" },
      operation: null,
    }
    const html = renderToStaticMarkup(createElement(SlashCommandMenu, {
      catalog,
      matches: ["native:plan", "plan"],
      activeIndex: 0,
      maxHeight: 240,
      onPick: () => {},
      hostCommands: { plan: { description: "Toggle plan mode", icon: ListTodo } },
    }))
    expect(html).toContain("/native:plan")
    expect(html).toContain("Native ACP plan command")
    expect(html).toContain("/plan")
    expect(html).toContain("Toggle plan mode")
  })
})
