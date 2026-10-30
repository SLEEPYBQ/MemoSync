import { t, useI18n } from "../i18n"
import { FolderOpen } from "lucide-react"
import type { EditorPreset } from "../../shared/protocol"

export const EDITOR_OPTIONS: Array<{ value: EditorPreset; label: string }> = [
  { value: "cursor", label: "Cursor" },
  { value: "xcode", label: "Xcode" },
  { value: "windsurf", label: "Windsurf" },
  { value: "custom", get label() { return t("chat:custom") } },
]

const ICON_SRC: Record<"cursor" | "finder" | "preview" | "defaultApp" | "xcode" | "terminal" | "windsurf" | "custom", string> = {
  cursor: "/editor-icons/cursor.png",
  defaultApp: "/editor-icons/default-app.png",
  finder: "/editor-icons/finder.png",
  preview: "/editor-icons/preview.png",
  xcode: "/editor-icons/xcode.png",
  terminal: "/editor-icons/terminal.png",
  windsurf: "/editor-icons/windsurf.png",
  custom: "/editor-icons/custom.png",
}

function AppIcon({ src, className }: { src: string; className?: string }) {
  useI18n()
  return <img src={src} alt="" aria-hidden="true" draggable={false} className={className} />
}

export function EditorIcon({ preset, className }: { preset: EditorPreset; className?: string }) {
  useI18n()
  switch (preset) {
    case "xcode":
      return <AppIcon src={ICON_SRC.xcode} className={className} />
    case "windsurf":
      return <AppIcon src={ICON_SRC.windsurf} className={className} />
    case "custom":
      return <AppIcon src={ICON_SRC.custom} className={className} />
    case "cursor":
    case "vscode":
    default:
      return <AppIcon src={ICON_SRC.cursor} className={className} />
  }
}

export function FinderIcon({ className }: { className?: string }) {
  useI18n()
  return <AppIcon src={ICON_SRC.finder} className={className} />
}

export function PreviewIcon({ className }: { className?: string }) {
  useI18n()
  return <AppIcon src={ICON_SRC.preview} className={className} />
}

export function DefaultAppIcon({ className }: { className?: string }) {
  useI18n()
  return <AppIcon src={ICON_SRC.defaultApp} className={className} />
}

export function FolderFallbackIcon({ className }: { className?: string }) {
  useI18n()
  return <FolderOpen className={className} />
}

export function TerminalIcon({ className }: { className?: string }) {
  useI18n()
  return <AppIcon src={ICON_SRC.terminal} className={className} />
}
