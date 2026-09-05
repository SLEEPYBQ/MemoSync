// CodeMirror-based code editor for the Files panel. One instance per file —
// parents key the component by file path so switching files remounts with a
// fresh undo history. Language is resolved from the file name and lazy-loaded
// (vite splits each grammar into its own chunk via @codemirror/language-data).
import { useEffect, useMemo, useRef } from "react"
import { EditorState, Compartment, Prec } from "@codemirror/state"
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor,
} from "@codemirror/view"
import {
  LanguageDescription, syntaxHighlighting, HighlightStyle, bracketMatching,
  indentOnInput, foldGutter,
} from "@codemirror/language"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { closeBrackets } from "@codemirror/autocomplete"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { languages } from "@codemirror/language-data"
import { tags as t } from "@lezer/highlight"

interface CodeEditorProps {
  fileName: string
  initialValue: string
  readOnly?: boolean
  onChange?: (doc: string) => void
  /** Invoked on Mod-S. Return true when handled (always preventDefaults). */
  onSave?: () => void
  /** Scroll to and select a 1-based line; bump `nonce` to re-trigger. */
  reveal?: { line: number; nonce: number }
}

// Palette follows GitHub's light theme (the app is light-locked); the chrome
// (background, gutter) inherits the app CSS variables instead so the editor
// blends in without hardcoding surface colors.
const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "#cf222e" },
  { tag: [t.string, t.special(t.string), t.inserted], color: "#0a3069" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#0550ae" },
  { tag: [t.comment, t.meta], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName], color: "#953800" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.tagName], color: "#116329" },
  { tag: [t.heading], color: "#0550ae", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#0a3069" },
  { tag: [t.regexp, t.escape], color: "#116329" },
  { tag: [t.deleted], color: "#cf222e" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
])

const chromeTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    backgroundColor: "transparent",
    color: "hsl(var(--foreground))",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "8px 0", caretColor: "hsl(var(--foreground))" },
  ".cm-line": { padding: "0 12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "hsl(var(--muted-foreground) / 0.55)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 16px", minWidth: "36px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px 0 0" },
  ".cm-activeLine": { backgroundColor: "hsl(var(--muted) / 0.45)" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "hsl(var(--muted-foreground))",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "hsl(var(--primary) / 0.18) !important",
  },
  ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
  ".cm-matchingBracket": {
    backgroundColor: "hsl(var(--primary) / 0.15)",
    outline: "1px solid hsl(var(--primary) / 0.3)",
  },
  ".cm-selectionMatch": { backgroundColor: "hsl(var(--primary) / 0.12)" },
})

/** Resolve the CodeMirror language for a file name (null → plain text). */
export function matchEditorLanguage(fileName: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, fileName)
}

export function CodeEditor({ fileName, initialValue, readOnly = false, onChange, onSave, reveal }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  // Refs keep the callbacks fresh without rebuilding editor extensions.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const compartments = useMemo(
    () => ({ language: new Compartment(), highlight: new Compartment(), readOnly: new Compartment() }),
    [],
  )

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        // Wrap long lines like Codex does — in a side panel, horizontal
        // scrolling reads as clipped content (macOS hides idle scrollbars).
        EditorView.lineWrapping,
        Prec.high(
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.()
                return true
              },
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        chromeTheme,
        compartments.highlight.of(syntaxHighlighting(lightHighlight)),
        compartments.language.of([]),
        compartments.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
        }),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    let cancelled = false
    const description = matchEditorLanguage(fileName)
    if (description) {
      void description.load().then((support) => {
        if (!cancelled && viewRef.current === view) {
          view.dispatch({ effects: compartments.language.reconfigure(support) })
        }
      })
    }

    return () => {
      cancelled = true
      viewRef.current = null
      view.destroy()
    }
    // Recreated only per file (parent keys this component by path); initial
    // doc changes for the same file are handled by CodeMirror itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, compartments])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.readOnly.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly, compartments])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !reveal) return
    const line = view.state.doc.line(Math.max(1, Math.min(reveal.line, view.state.doc.lines)))
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    })
    view.focus()
  }, [reveal])

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
}
