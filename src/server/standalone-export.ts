import path from "node:path"
import { cp as copyPath, copyFile, mkdir, stat, writeFile } from "node:fs/promises"
import type {
  StandaloneTranscriptAttachmentMode,
  StandaloneTranscriptBundle,
  StandaloneTranscriptExportCommandResult,
  StandaloneTranscriptTheme,
  TranscriptEntry,
} from "../shared/types"
import { APP_VERSION } from "../shared/branding"
import { getProjectExportDir } from "./paths"

const STANDALONE_TRANSCRIPT_BUNDLE_VERSION = 1 as const
// Absolute local paths are scrubbed from the bundle before it is written: an
// export is a self-contained folder the user may hand to anyone.
const STANDALONE_EXPORT_WORKSPACE_PATH = "/workspace"

export interface WriteStandaloneTranscriptExportArgs {
  chatId: string
  title: string
  localPath: string
  theme: StandaloneTranscriptTheme
  attachmentMode: StandaloneTranscriptAttachmentMode
  messages: TranscriptEntry[]
}

export interface StandaloneExportDeps {
  viewerDistDir?: string
  now?: Date
  mkdir?: typeof mkdir
  writeFile?: typeof writeFile
  copyDirectory?: (sourceDir: string, targetDir: string) => Promise<void>
  copyFile?: typeof copyFile
  pathExists?: (targetPath: string) => Promise<boolean>
}

interface PreparedMessagesResult {
  messages: TranscriptEntry[]
  totalAttachmentCount: number
  bundledAttachmentCount: number
}

export function getStandaloneViewerDistDir() {
  return path.join(import.meta.dir, "..", "..", "dist", "export-viewer")
}

/**
 * Export a chat transcript as a standalone local web page under the project's
 * exports directory. Local-only: nothing is uploaded anywhere.
 */
export async function writeStandaloneTranscriptExport(
  args: WriteStandaloneTranscriptExportArgs,
  deps: StandaloneExportDeps = {},
): Promise<StandaloneTranscriptExportCommandResult> {
  const viewerDistDir = deps.viewerDistDir ?? getStandaloneViewerDistDir()
  const ensureDir = deps.mkdir ?? mkdir
  const writeFileImpl = deps.writeFile ?? writeFile
  const copyDirectory = deps.copyDirectory ?? (async (sourceDir, targetDir) => {
    await copyPath(sourceDir, targetDir, { recursive: true })
  })
  const copyFileImpl = deps.copyFile ?? copyFile
  const pathExists = deps.pathExists ?? defaultPathExists
  const now = deps.now ?? new Date()

  if (!(await pathExists(viewerDistDir))) {
    throw new Error("Standalone viewer bundle not found. Run `bun run build`.")
  }

  const exportRootDir = getProjectExportDir(args.localPath)
  await ensureDir(exportRootDir, { recursive: true })

  const outputDir = await resolveUniqueExportDir(exportRootDir, args.title || args.chatId, now, pathExists)
  await copyDirectory(viewerDistDir, outputDir)

  const attachmentsDir = path.join(outputDir, "attachments")
  const prepared = await prepareStandaloneMessages(args.messages, {
    attachmentMode: args.attachmentMode,
    localPath: args.localPath,
    attachmentsDir,
    copyFile: copyFileImpl,
    mkdir: ensureDir,
    pathExists,
  })

  const bundle: StandaloneTranscriptBundle = {
    version: STANDALONE_TRANSCRIPT_BUNDLE_VERSION,
    chatId: args.chatId,
    title: args.title,
    localPath: STANDALONE_EXPORT_WORKSPACE_PATH,
    exportedAt: now.toISOString(),
    viewerVersion: APP_VERSION,
    theme: args.theme,
    attachmentMode: args.attachmentMode,
    messages: prepared.messages,
  }

  const transcriptJson = `${JSON.stringify(bundle, null, 2)}\n`
  const transcriptJsonPath = path.join(outputDir, "transcript.json")
  await writeFileImpl(transcriptJsonPath, transcriptJson, "utf8")

  return {
    ok: true,
    outputDir,
    indexHtmlPath: path.join(outputDir, "index.html"),
    transcriptJsonPath,
    attachmentMode: args.attachmentMode,
    totalAttachmentCount: prepared.totalAttachmentCount,
    bundledAttachmentCount: prepared.bundledAttachmentCount,
  }
}

async function prepareStandaloneMessages(
  messages: TranscriptEntry[],
  args: {
    attachmentMode: StandaloneTranscriptAttachmentMode
    localPath: string
    attachmentsDir: string
    copyFile: typeof copyFile
    mkdir: typeof mkdir
    pathExists: (targetPath: string) => Promise<boolean>
  },
): Promise<PreparedMessagesResult> {
  const preparedMessages = structuredClone(messages)
  let totalAttachmentCount = 0
  let bundledAttachmentCount = 0
  let attachmentsDirCreated = false

  for (const message of preparedMessages) {
    if (message.kind === "memory_candidates") {
      // Older transcript rows duplicated candidate content and details. A
      // hidden UI placeholder is not enough: scrub those fields from the JSON
      // bundle itself before it is written.
      message.candidates = message.candidates.map(({ id }) => ({ id }))
      continue
    }
    if (message.kind !== "user_prompt" || !message.attachments?.length) {
      continue
    }

    totalAttachmentCount += message.attachments.length

    for (const attachment of message.attachments) {
      if (args.attachmentMode === "metadata") {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      if (!attachment.absolutePath || !(await args.pathExists(attachment.absolutePath))) {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      if (!attachmentsDirCreated) {
        await args.mkdir(args.attachmentsDir, { recursive: true })
        attachmentsDirCreated = true
      }

      const exportedFileName = `${sanitizeFileNameSegment(attachment.id)}-${sanitizeFileNameSegment(path.basename(attachment.displayName || attachment.absolutePath))}`
      const destinationPath = path.join(args.attachmentsDir, exportedFileName)
      await args.copyFile(attachment.absolutePath, destinationPath)
      bundledAttachmentCount += 1

      const relativeDestinationPath = `./attachments/${exportedFileName}`
      attachment.absolutePath = relativeDestinationPath
      attachment.relativePath = relativeDestinationPath
      attachment.contentUrl = relativeDestinationPath
    }
  }

  rewriteLocalPathsForExport(preparedMessages, args.localPath)

  return {
    messages: preparedMessages,
    totalAttachmentCount,
    bundledAttachmentCount,
  }
}

function rewriteAttachmentAsMetadata(attachment: {
  absolutePath: string
  relativePath: string
  contentUrl: string
}) {
  attachment.absolutePath = ""
  attachment.relativePath = ""
  attachment.contentUrl = ""
}

async function resolveUniqueExportDir(
  exportRootDir: string,
  title: string,
  now: Date,
  pathExists: (targetPath: string) => Promise<boolean>,
) {
  const baseName = `${sanitizeFileNameSegment(title) || "chat"}-${formatExportTimestamp(now)}`
  let candidate = path.join(exportRootDir, baseName)
  let suffix = 2

  while (await pathExists(candidate)) {
    candidate = path.join(exportRootDir, `${baseName}-${suffix}`)
    suffix += 1
  }

  return candidate
}

function formatExportTimestamp(value: Date) {
  return value
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/u, "Z")
}

function sanitizeFileNameSegment(value: string) {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

async function defaultPathExists(targetPath: string) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

function rewriteLocalPathsForExport(value: unknown, localPath: string) {
  if (!localPath) {
    return
  }

  if (typeof value === "string") {
    return value.replaceAll(localPath, STANDALONE_EXPORT_WORKSPACE_PATH)
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rewriteLocalPathsForExport(value[index], localPath)
    }
    return value
  }

  if (!value || typeof value !== "object") {
    return value
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    ;(value as Record<string, unknown>)[key] = rewriteLocalPathsForExport(nestedValue, localPath)
  }

  return value
}
