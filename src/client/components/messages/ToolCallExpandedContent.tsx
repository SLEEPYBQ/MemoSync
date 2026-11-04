import { t, useI18n, getLocale } from "../../i18n"
import { Check, Copy } from "lucide-react"
import { Fragment, useMemo, useState } from "react"
import { copyTextToClipboard } from "../../lib/clipboard"
import { cn } from "../../lib/utils"
import type { ProcessedToolCall } from "./types"
import { FileContentView } from "./FileContentView"

type ReadImageBlock = {
  type: "image"
  data: string
  mimeType?: string
}

function extractReadImageBlocks(value: unknown): ReadImageBlock[] {
  const blocks = (
    value
    && typeof value === "object"
    && "content" in value
    && Array.isArray((value as { content?: unknown }).content)
  )
    ? (value as { content: unknown[] }).content
    : Array.isArray(value)
      ? value
      : []

  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "image") {
      return []
    }

    if ("data" in block && typeof block.data === "string") {
      return [{
        type: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
      } satisfies ReadImageBlock]
    }

    if (
      "source" in block
      && block.source
      && typeof block.source === "object"
      && "type" in block.source
      && block.source.type === "base64"
      && "data" in block.source
      && typeof block.source.data === "string"
    ) {
      return [{
        type: "image",
        data: block.source.data,
        mimeType: typeof block.source.media_type === "string" ? block.source.media_type : undefined,
      } satisfies ReadImageBlock]
    }

    return []
  })
}

export function ReadResultImages({ images }: { images: ReadonlyArray<ReadImageBlock> }) {
  useI18n()
  return (
    <div className="flex flex-col gap-3">
      {images.map((image, index) => {
        const mimeType = image.mimeType || "image/png"
        return (
          <div key={`${mimeType}:${index}`} className="overflow-hidden rounded-lg border border-border bg-muted/20">
            <img
              src={`data:${mimeType};base64,${image.data}`}
              alt={t("chat:readResultValue0", { v0: index + 1 })}
              className="max-h-[50vh] w-full object-contain bg-background"
            />
          </div>
        )
      })}
    </div>
  )
}

/** A short value reads as itself; anything structured keeps its shape. */
function formatInputValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

/** What a tool was asked and what came back, as one card rather than two labelled boxes. */
function ToolExchange({ command, background, input, hasResult, result, isError, copyText }: {
  command?: string
  background: boolean
  input?: object
  hasResult: boolean
  result: string
  isError: boolean
  copyText: string
}) {
  const [copied, setCopied] = useState(false)
  const fields = Object.entries(input ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== "")
  const asked = command !== undefined || fields.length > 0
  return (
    <div className="group/exchange relative overflow-hidden rounded-xl bg-muted/50 font-mono text-[12px] leading-5 shadow-[0_0_0_1px_hsl(var(--border)/0.7)]">
      <button
        type="button"
        aria-label={t("chat:copy")}
        title={t("chat:copy")}
        onClick={async () => {
          if (!await copyTextToClipboard(copyText)) return
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
        className="absolute right-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/exchange:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {command !== undefined ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 py-2 pr-9 text-foreground/90">
          <span aria-hidden className="select-none text-muted-foreground">$ </span>{command}
          {background ? <span className="ml-2 select-none text-muted-foreground">{t("chat:background")}</span> : null}
        </pre>
      ) : null}
      {fields.length > 0 ? (
        <dl className="grid max-h-40 grid-cols-[auto_minmax(0,1fr)] gap-x-3 overflow-auto px-3 py-2 pr-9">
          {fields.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="select-none text-muted-foreground">{key}</dt>
              <dd className="whitespace-pre-wrap break-words text-foreground/90"><pre className="whitespace-pre-wrap break-words font-[inherit]">{formatInputValue(value)}</pre></dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {hasResult ? (
        <pre className={cn(
          "max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2",
          asked && "border-t border-border/60",
          !asked && "pr-9",
          isError ? "text-destructive/90" : "text-muted-foreground",
        )}>
          {result || <span className="select-none opacity-70">{t("chat:toolNoOutput")}</span>}
        </pre>
      ) : null}
    </div>
  )
}

// Mounted by ExpandableRow only while open. Keep all payload work here.
export function ToolCallExpandedContent({ message }: { message: ProcessedToolCall }) {
  useI18n()
  const hasResult = message.result !== undefined
  const isBashTool = message.toolKind === "bash"
  const isWriteTool = message.toolKind === "write_file"
  const isEditTool = message.toolKind === "edit_file"
  const isDeleteTool = message.toolKind === "delete_file"
  const isReadTool = message.toolKind === "read_file"

  const resultText = useMemo(() => {
    if (typeof message.result === "string") return message.result
    if (!message.result) return ""
    if (typeof message.result === "object" && message.result !== null && "content" in message.result) {
      const content = (message.result as { content?: unknown }).content
      if (typeof content === "string") return content
    }
    return JSON.stringify(message.result, null, 2)
  }, [message.result, getLocale()])

  const readImages = useMemo(() => {
    if (!isReadTool) {
      return [] as ReadImageBlock[]
    }

    if (message.result && typeof message.result === "object" && "blocks" in message.result) {
      const blocks = (message.result as { blocks?: unknown }).blocks
      if (Array.isArray(blocks)) {
        const hydratedBlocks = extractReadImageBlocks(blocks)
        if (hydratedBlocks.length > 0) {
          return hydratedBlocks
        }
      }
    }

    return extractReadImageBlocks(message.rawResult)
  }, [isReadTool, message.rawResult, message.result])

  const inputText = useMemo(() => {
    if (message.toolKind === "bash") return message.input.command
    return JSON.stringify(message.input, null, 2)
  }, [message])

  // These tools have a better view of their own than the raw exchange: the file
  // or the diff. They fall back to the card only to say why they failed.
  const hasFileView = !message.isError && (isReadTool || isWriteTool || isEditTool || isDeleteTool)

  return (
    <div className="my-1.5 ml-[26px] min-w-0 text-sm">
      {isEditTool && !message.isError ? (
        <FileContentView content="" isDiff oldString={message.input.oldString} newString={message.input.newString} />
      ) : null}
      {isDeleteTool && !message.isError ? <FileContentView content={message.input.content} /> : null}
      {isWriteTool && !message.isError ? <FileContentView content={message.input.content} /> : null}
      {isReadTool && hasResult && !message.isError ? (
        readImages.length > 0 ? <ReadResultImages images={readImages} /> : <FileContentView content={resultText} />
      ) : null}
      {hasFileView ? null : (
        <ToolExchange
          command={isBashTool ? message.input.command : undefined}
          background={isBashTool && Boolean(message.input.runInBackground)}
          input={isBashTool ? undefined : message.input}
          hasResult={hasResult}
          result={resultText}
          isError={Boolean(message.isError)}
          copyText={[inputText, resultText].filter(Boolean).join("\n\n")}
        />
      )}
    </div>
  )
}
