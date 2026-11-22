import type { KeybindingAction } from "./types"

export type ModifierFlags = {
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

export type ParsedBinding = ModifierFlags & { key: string }

export const MODIFIER_TOKENS = new Map<string, keyof ModifierFlags>([
  ["cmd", "meta"],
  ["meta", "meta"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
])

export function parseModifiers(binding: string): ModifierFlags {
  const modifiers: ModifierFlags = { ctrl: false, meta: false, alt: false, shift: false }
  for (const part of binding.split("+")) {
    const modifier = MODIFIER_TOKENS.get(part.trim().toLowerCase())
    if (modifier) modifiers[modifier] = true
  }
  return modifiers
}

export function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding.split("+").map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null

  const parsed: ParsedBinding = {
    key: "",
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  }

  for (const part of parts) {
    const token = part.toLowerCase()
    const modifier = MODIFIER_TOKENS.get(token)
    if (modifier === "ctrl") {
      parsed.ctrl = true
      continue
    }
    if (modifier === "meta") {
      parsed.meta = true
      continue
    }
    if (modifier === "alt") {
      parsed.alt = true
      continue
    }
    if (modifier === "shift") {
      parsed.shift = true
      continue
    }
    if (parsed.key) {
      return null
    }
    parsed.key = token
  }

  return parsed.key ? parsed : null
}

export function findBindingConflict(
  bindings: Record<KeybindingAction, string[]>,
  action: KeybindingAction,
  chord: string,
): KeybindingAction | null {
  const incomingKeyed = action === "jumpToSidebarChat" ? null : parseBinding(chord)
  const incoming = action === "jumpToSidebarChat" ? parseModifiers(chord) : incomingKeyed
  if (!incoming) return null
  return (Object.keys(bindings) as KeybindingAction[]).find((other) => {
    if (other === action || other === "openInEditor") return false
    return bindings[other].some((binding) => {
      const existingKeyed = other === "jumpToSidebarChat" ? null : parseBinding(binding)
      const existing = other === "jumpToSidebarChat" ? parseModifiers(binding) : existingKeyed
      if (!existing || incoming.ctrl !== existing.ctrl || incoming.meta !== existing.meta
        || incoming.alt !== existing.alt || incoming.shift !== existing.shift) return false
      if (action === "jumpToSidebarChat") return /^[1-9]$/.test(existingKeyed?.key ?? "")
      if (other === "jumpToSidebarChat") return /^[1-9]$/.test(incomingKeyed?.key ?? "")
      return incomingKeyed?.key === existingKeyed?.key
    })
  }) ?? null
}
