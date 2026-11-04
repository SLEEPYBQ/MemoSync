import type { ChatCommandCatalog, RuntimeCommand } from "../../shared/runtime-commands"
import { t } from "../i18n"

/** Keep equally named native commands and skills independently addressable. */
export function runtimeCommandToken(command: RuntimeCommand, commands: RuntimeCommand[]): string {
  const name = command.name.replace(/^\//, "")
  return commands.filter(item => item.name.replace(/^\//, "") === name).length > 1 ? `${command.namespace}:${name}` : name
}

/** Native slash commands are controls; never silently send /compact as chat text. */
export function resolveRuntimeSlash(value: string, catalog: ChatCommandCatalog | null | undefined): { command: RuntimeCommand; args: string } | null {
  const match = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(value.trim())
  if (!match) return null
  if (!catalog?.runtimeKey || catalog.commands.status !== "ready") throw new Error(t("commands:notReady"))
  const command = catalog.commands.items.find(item => runtimeCommandToken(item, catalog.commands.items) === match[1])
  if (!command) throw new Error(t("commands:unknownCommand"))
  if (command.route === "compact" && catalog.compact.status !== "available") throw new Error(catalog.compact.reason || t("commands:compactUnavailable"))
  return { command, args: match[2] ?? "" }
}
