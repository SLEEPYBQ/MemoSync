import type { ChatCommandCatalog, RuntimeCommand } from "../../shared/runtime-commands"
import { t } from "../i18n"

/** Host controls that must never fall back to ordinary chat text. */
const CONTROL_COMMANDS = new Set(["compact"])
const SLASH = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/

/** Keep equally named native commands and skills independently addressable. */
export function runtimeCommandToken(command: RuntimeCommand, commands: RuntimeCommand[]): string {
  const name = command.name.replace(/^\//, "")
  return commands.filter(item => item.name.replace(/^\//, "") === name).length > 1 ? `${command.namespace}:${name}` : name
}

export function isSlashInput(value: string) { return SLASH.test(value.trim()) }

/** The native list is still on its way: a slash command should wait for it rather than fail. */
export function runtimeCatalogSettling(catalog: ChatCommandCatalog | null | undefined) {
  if (!catalog) return true
  if (catalog.preparation?.status === "preparing") return true
  return catalog.preparation?.status !== "error" && catalog.commands.status === "unknown"
}

/**
 * A known native command or skill runs through its native route. Anything else
 * that merely starts with "/" goes to the engine as text, which handles its own
 * slash syntax. Only host controls such as /compact refuse to degrade to text.
 */
export function resolveRuntimeSlash(value: string, catalog: ChatCommandCatalog | null | undefined): { command: RuntimeCommand; args: string } | null {
  const match = SLASH.exec(value.trim())
  if (!match) return null
  const ready = Boolean(catalog?.runtimeKey) && catalog?.commands.status === "ready"
  const items = ready ? catalog!.commands.items : []
  const command = items.find(item => runtimeCommandToken(item, items) === match[1])
  if (command) {
    if (command.route === "compact" && catalog!.compact.status !== "available") throw new Error(catalog!.compact.reason || t("commands:compactUnavailable"))
    return { command, args: match[2] ?? "" }
  }
  const bare = match[1].replace(/^(?:native|skill):/, "")
  if (CONTROL_COMMANDS.has(bare)) {
    if (!ready) throw new Error(t("commands:notReady"))
    throw new Error(catalog!.compact.reason || t("commands:compactUnavailable"))
  }
  if (items.filter(item => item.name.replace(/^\//, "") === bare).length > 1) throw new Error(t("commands:ambiguousCommand", { name: bare }))
  return null
}
