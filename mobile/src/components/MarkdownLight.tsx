// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/native/CodeBlockFrame.tsx
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

import React, { useEffect, useMemo, useRef, useState } from "react"
import {
  Clipboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { ColorTokens } from "../theme"
import { colorWithAlpha, radius, spacing } from "../theme"
import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "../lib/typography"

/** System monospace, matching the web UI's system-mono code rendering. */
const monoFamily = Platform.select({ ios: "Menlo", default: "monospace" })

/**
 * Dependency-free markdown-light renderer. It intentionally handles the
 * ordinary shapes agents emit — prose, headings, lists, quotes, tables and
 * fenced code — and degrades everything else to readable plain text.
 */

interface MarkdownLightProps {
  text: string
  colors: ColorTokens
}

interface InlineSegment {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  url?: string
}

function parseInline(line: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((?:https?:\/\/)[^\s)]+\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) segments.push({ text: line.slice(lastIndex, match.index) })
    if (match[1]) {
      segments.push({ text: match[1].slice(1, -1), code: true })
    } else if (match[2]) {
      segments.push({ text: match[2].slice(2, -2), bold: true })
    } else if (match[3]) {
      segments.push({ text: match[3].slice(2, -2), strike: true })
    } else if (match[4]) {
      segments.push({ text: match[4].slice(1, -1), italic: true })
    } else if (match[5]) {
      const close = match[5].lastIndexOf("](")
      segments.push({
        text: match[5].slice(1, close),
        url: match[5].slice(close + 2, -1),
      })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < line.length) segments.push({ text: line.slice(lastIndex) })
  return segments.length ? segments : [{ text: line }]
}

type ListItemBlock = {
  type: "listItem"
  content: string
  ordered: boolean
  index: number
  depth: number
  checked?: boolean
}

type Block =
  | { type: "code"; content: string; language: string }
  | { type: "heading"; level: number; content: string }
  | ListItemBlock
  | { type: "listGroup"; items: ListItemBlock[] }
  | { type: "blockquote"; content: string }
  | { type: "table"; rows: string[][] }
  | { type: "rule" }
  | { type: "paragraph"; content: string }

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
}

function groupConsecutiveListItems(blocks: Block[]): Block[] {
  // Markdown lists are one visual unit. Keeping each item as a top-level block
  // puts paragraph-sized gaps between bullets; grouping them preserves the
  // compact rhythm used by the reference mobile renderer.
  const grouped: Block[] = []
  for (const block of blocks) {
    if (block.type === "listItem") {
      const previous = grouped[grouped.length - 1]
      if (previous?.type === "listGroup") {
        previous.items.push(block)
      } else {
        grouped.push({ type: "listGroup", items: [block] })
      }
      continue
    }
    grouped.push(block)
  }
  return grouped
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const paragraphLines: string[] = []
  let inCode = false
  let codeLanguage = ""
  let codeBuffer: string[] = []

  const flushParagraph = () => {
    if (!paragraphLines.length) return
    blocks.push({ type: "paragraph", content: paragraphLines.join("\n") })
    paragraphLines.length = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const fence = /^\s*```\s*([^`]*)\s*$/.exec(line)
    if (fence) {
      if (inCode) {
        blocks.push({ type: "code", content: codeBuffer.join("\n"), language: codeLanguage })
        codeBuffer = []
        codeLanguage = ""
        inCode = false
      } else {
        flushParagraph()
        codeLanguage = (fence[1] ?? "").trim().split(/\s+/)[0] ?? ""
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuffer.push(line)
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      continue
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph()
      blocks.push({ type: "rule" })
      continue
    }

    // Markdown table: header row, separator row, then zero or more body rows.
    if (line.trim().startsWith("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? "")) {
      flushParagraph()
      const rows = [splitTableRow(line)]
      index += 2
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
        rows.push(splitTableRow(lines[index] ?? ""))
        index += 1
      }
      index -= 1
      blocks.push({ type: "table", rows })
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ type: "heading", level: heading[1].length, content: heading[2].trim() })
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph()
      const quoteLines: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, ""))
        index += 1
      }
      index -= 1
      blocks.push({ type: "blockquote", content: quoteLines.join("\n") })
      continue
    }

    const unordered = /^(\s*)[-•*]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line)
    if (unordered) {
      flushParagraph()
      const indent = unordered[1].replace(/\t/g, "  ").length
      blocks.push({
        type: "listItem",
        content: unordered[3],
        ordered: false,
        index: 0,
        depth: Math.min(4, Math.floor(indent / 2)),
        checked: unordered[2] == null ? undefined : unordered[2].toLowerCase() === "x",
      })
      continue
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      const indent = ordered[1].replace(/\t/g, "  ").length
      blocks.push({
        type: "listItem",
        content: ordered[3],
        ordered: true,
        index: Number.parseInt(ordered[2], 10),
        depth: Math.min(4, Math.floor(indent / 2)),
      })
      continue
    }

    paragraphLines.push(line)
  }

  if (inCode && codeBuffer.length) {
    blocks.push({ type: "code", content: codeBuffer.join("\n"), language: codeLanguage })
  }
  flushParagraph()
  return groupConsecutiveListItems(blocks)
}

function InlineText({ line, colors, muted }: { line: string; colors: ColorTokens; muted?: boolean }) {
  const segments = useMemo(() => parseInline(line), [line])
  return (
    <Text style={[styles.inlineBase, { color: muted ? colors.mutedForeground : colors.foreground }]}>
      {segments.map((segment, index) => (
        <Text
          key={index}
          onPress={
            segment.url
              ? () => {
                  void Linking.openURL(segment.url ?? "").catch(() => {})
                }
              : undefined
          }
          style={[
            segment.bold ? styles.bold : null,
            segment.italic ? styles.italic : null,
            segment.strike ? styles.strike : null,
            segment.code
              ? [styles.inlineCode, { backgroundColor: colors.muted, color: colors.foreground }]
              : null,
            segment.url ? [styles.link, { color: colors.focus }] : null,
          ]}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  )
}

function CodeBlock({ content, language, colors }: { content: string; language: string; colors: ColorTokens }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const copy = () => {
    Clipboard.setString(content)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1_400)
  }

  const label = language ? language.toLowerCase() : "code"
  return (
    <View style={[styles.codeBlock, { backgroundColor: colors.sidebar, borderColor: colors.border }]}>
      <View style={[styles.codeHeader, { borderBottomColor: colorWithAlpha(colors.foreground, 0.1) }]}>
        <Text style={[styles.codeLanguage, { color: colorWithAlpha(colors.foreground, 0.62) }]}>{label}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy code" hitSlop={8} onPress={copy} style={styles.copyButton}>
          <Ionicons name={copied ? "checkmark" : "copy-outline"} size={14} color={copied ? colors.successForeground : colorWithAlpha(colors.foreground, 0.62)} />
          <Text style={[styles.copyLabel, { color: copied ? colors.successForeground : colorWithAlpha(colors.foreground, 0.62) }]}>
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={[styles.codeText, { color: colors.foreground }]}>
          {content}
        </Text>
      </ScrollView>
    </View>
  )
}

function TableBlock({ rows, colors }: { rows: string[][]; colors: ColorTokens }) {
  const columnCount = Math.max(...rows.map((row) => row.length), 0)
  if (!columnCount) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.card }]}>
        {rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={[
              styles.tableRow,
              rowIndex === 0 ? { backgroundColor: colors.muted } : null,
              rowIndex < rows.length - 1 ? { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth } : null,
            ]}
          >
            {Array.from({ length: columnCount }, (_, columnIndex) => (
              <View
                key={columnIndex}
                style={[
                  styles.tableCell,
                  columnIndex > 0 ? { borderLeftColor: colors.border, borderLeftWidth: StyleSheet.hairlineWidth } : null,
                ]}
              >
                <Text
                  style={[
                    styles.tableText,
                    { color: rowIndex === 0 ? colors.foreground : colors.mutedForeground },
                    rowIndex === 0 ? styles.tableHeaderText : null,
                  ]}
                >
                  {row[columnIndex] ?? ""}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function ListMarker({ block, colors }: { block: ListItemBlock; colors: ColorTokens }) {
  if (block.checked !== undefined) {
    return (
      <View style={[styles.checkbox, { borderColor: block.checked ? colors.success : colors.mutedIcon, backgroundColor: block.checked ? colors.success : "transparent" }]}>
        {block.checked ? <Ionicons name="checkmark" size={10} color={colors.card} /> : null}
      </View>
    )
  }
  return <Text style={[styles.listMarkerText, { color: colors.mutedForeground }]}>{block.ordered ? `${block.index}.` : "•"}</Text>
}

export function MarkdownLight({ text, colors }: MarkdownLightProps) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return <CodeBlock key={index} content={block.content} language={block.language} colors={colors} />
        }
        if (block.type === "heading") {
          const role = block.level === 1 ? MOBILE_TYPOGRAPHY.title : block.level === 2 ? MOBILE_TYPOGRAPHY.headline : MOBILE_TYPOGRAPHY.body
          return (
            <Text key={index} style={[styles.heading, role, { color: colors.foreground }]}>
              {block.content}
            </Text>
          )
        }
        if (block.type === "listGroup") {
          return (
            <View key={index} style={styles.listGroup}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={[styles.listRow, { paddingLeft: item.depth * 16 }]}>
                  <View style={styles.listMarker}>
                    <ListMarker block={item} colors={colors} />
                  </View>
                  <View style={styles.listContent}>
                    <InlineText line={item.content} colors={colors} />
                  </View>
                </View>
              ))}
            </View>
          )
        }
        if (block.type === "blockquote") {
          return (
            <View key={index} style={[styles.blockquote, { borderLeftColor: colors.border, backgroundColor: colorWithAlpha(colors.mutedForeground, 0.055) }]}>
              {block.content.split("\n").map((line, lineIndex) => (
                <InlineText key={lineIndex} line={line} colors={colors} muted />
              ))}
            </View>
          )
        }
        if (block.type === "table") {
          return <TableBlock key={index} rows={block.rows} colors={colors} />
        }
        if (block.type === "rule") {
          return <View key={index} style={[styles.rule, { backgroundColor: colors.border }]} />
        }
        return (
          <View key={index} style={styles.paragraph}>
            {block.content.split("\n").map((line, lineIndex) => (
              <InlineText key={lineIndex} line={line} colors={colors} />
            ))}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.md - 1,
  },
  paragraph: {
    gap: spacing.xxs,
  },
  inlineBase: {
    fontSize: MOBILE_TYPOGRAPHY.body.fontSize,
    lineHeight: 24,
  },
  bold: {
    fontWeight: "600",
  },
  italic: {
    fontStyle: "italic",
  },
  strike: {
    textDecorationLine: "line-through",
  },
  link: {
    textDecorationLine: "underline",
  },
  inlineCode: {
    fontFamily: monoFamily,
    fontSize: MOBILE_TYPOGRAPHY.footnote.fontSize,
    borderRadius: radius.sm,
    paddingHorizontal: 3,
  },
  heading: {
    fontWeight: "600",
    marginTop: spacing.xs,
  },
  listGroup: {
    gap: spacing.xs,
  },
  listRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingRight: spacing.xs,
  },
  listMarker: {
    width: 20,
    alignItems: "flex-end",
    paddingTop: 2,
  },
  listMarkerText: {
    fontSize: MOBILE_TYPOGRAPHY.body.fontSize,
    lineHeight: 24,
  },
  checkbox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1.4,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  listContent: {
    minWidth: 0,
    flex: 1,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xxs,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.xs,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.base,
    overflow: "hidden",
    alignSelf: "flex-start",
  },
  tableRow: {
    flexDirection: "row",
  },
  tableCell: {
    minWidth: 96,
    maxWidth: 220,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  tableText: {
    ...MOBILE_TYPOGRAPHY.footnote,
  },
  tableHeaderText: {
    fontWeight: "600",
  },
  codeBlock: {
    borderRadius: radius.base,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  codeHeader: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
  },
  codeLanguage: {
    fontFamily: monoFamily,
    fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
    fontWeight: "500",
  },
  copyButton: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  copyLabel: {
    ...MOBILE_TYPOGRAPHY.caption,
    fontWeight: "500",
  },
  codeText: {
    fontFamily: monoFamily,
    fontSize: MOBILE_CODE_SURFACE.fontSize,
    lineHeight: MOBILE_CODE_SURFACE.rowHeight - 2,
    paddingHorizontal: MOBILE_CODE_SURFACE.codePadding,
    paddingVertical: MOBILE_CODE_SURFACE.codePadding,
  },
})
