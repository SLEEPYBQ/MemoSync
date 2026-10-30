// Stable UI message codes; English is retained for old clients and diagnostics.
// No locale or browser dependency belongs on the server.
export const SERVER_UI_COPY = {
  "newChat": "New Chat",
  "forkedChat": "Fork: {{v0}}",
  "forkedNewChat": "Fork: New Chat",
  "projectNotFound": "Project not found",
  "chatNotFound": "Chat not found",
  "unavailable": "Unavailable",
  "invalidJson": "Invalid JSON",
  "invalidEnvelope": "Invalid envelope",
  "unauthorized": "Unauthorized",
  "internalServerError": "Internal server error",
  "updateUnavailable": "Update manager unavailable.",
  "mergeUnavailable": "Merge unavailable.",
  "mergePreviewUnavailable": "Merge preview unavailable.",
  "publishFailed": "Publish failed",
  "mergeFailed": "Merge failed",
  "providerValidationUnavailable": "LLM provider validation unavailable.",
  "skillSourceInvalid": "Skill source must be an owner/repo pair.",
  "skillIdInvalid": "Skill id is invalid.",
  "skillSearchFailed": "Skills search failed with status {{v0}}.",
  "skillCliFailed": "skills CLI exited with code {{v0}}.",
  "uploadCount": "You can upload up to {{v0}} files at a time.",
  "uploadFileSize": "File \"{{v0}}\" exceeds the {{v1}} MB limit.",
  "uploadTotalSize": "Combined uploads exceed the {{v0}} MB limit.",
  "uploadTooLarge": "Upload request is too large.",
  "uploadUnreadable": "Could not read the upload request. Please try again.",
  "uploadEmpty": "No files uploaded",
  "uploadMetadata": "Invalid upload size metadata.",
  "uploadMismatch": "The uploaded file size does not match. Please try again.",
  "uploadFailed": "Upload failed",
  "attachmentPath": "Invalid attachment path",
  "attachmentNotFound": "Attachment not found",
  "projectFilePath": "Invalid project file path",
  "fileNotFound": "File not found",
  "fileTooLarge": "File too large to save",
  "fileWriteFailed": "Failed to write file",
  "fileTargetInvalid": "File save target is not a file",
  "inactiveChat": "This is not an active chat.",
  "unsupportedAudit": "Audit actions are only available in a supported MemoSync chat.",
  "memoryNotVisible": "This memory is not in the current chat's Visible Memory Pool.",
  "invalidField": "invalid {{v0}}: {{v1}}",
  "stringField": "{{v0}} must be a string",
  "numberField": "{{v0}} must be a number",
  "requiredField": "{{v0}} is required",
  "requiredFields": "{{v0}} are required",
  "surfaceInvalid": "surface must be board or chat_gate",
  "invalidAction": "action must be add or remove",
  "mutedNotFound": "no muted proposal for {{v0}}",
  "contentScope": "content and scope are required",
  "projectScope": "scope 'project' requires projectId",
  "sessionScope": "scope 'session' requires sessionId",
  "memoryIds": "ids must be an array of memory id strings",
  "keepIds": "ids[] and keepId are required",
  "memoryNotFound": "memory not found: {{v0}}",
  "rollbackFailed": "rollback failed",
  "auditUnavailable": "Audit admission is unavailable",
  "flagActiveOnly": "only an active memory can be flagged",
  "revisionService": "revision drafting needs the LLM service",
  "noFix": "no fix could be drafted (open revision, unchanged draft, or the memory moved)",
  "injectionService": "injection revision needs the LLM service",
  "workingMemoryInactive": "This Working Memory selection is no longer active.",
  "usePlanService": "memory use planning needs the LLM service",
  "maintenanceUnavailable": "maintenance is unavailable",
  "kindInvalid": "kind must be conflict | redundant | stale",
  "redundantOther": "otherId is required for a redundant pair",
  "mergeKeep": "action must be 'merge' or 'keep'",
  "mergeMoved": "merge draft could not bind (a memory moved) — re-open the card",
  "redundantFailed": "redundant action failed",
  "keepArchive": "action must be 'keep' or 'archive'",
  "attentionFailed": "attention action failed",
  "sanitizeService": "sanitize needs the LLM service and none is configured",
  "sanitizeFailed": "sanitize failed",
  "transferInactive": "source memory is no longer active; review Transfer again",
  "sourceVersion": "sourceVersion must be a positive integer",
  "sourceChanged": "source memory changed or is no longer active; review Transfer again",
  "targetSession": "targetScope 'session' requires targetSessionId",
  "targetProject": "targetScope 'project' requires targetProjectId",
  "landingRoute": "landingRoute must be new, reinforces, or conflicts",
  "landingTarget": "landingTargetId is required for a reviewed landing",
  "landingVersion": "landingTargetVersion must be a positive integer",
  "selfLanding": "source memory cannot be its own landing target",
  "landingChanged": "landing target changed or is no longer active; review Transfer again",
  "landingOutside": "landing target is outside the selected destination; review Transfer again",
  "newLandingTarget": "new landing cannot include a target",
  "badProjectId": "bad project id",
  "importScope": "scope must be 'personal' or 'project'",
  "projectIdRequired": "projectId is required for project scope",
  "captureMode": "mode must be 'ask' or 'auto'",
  "candidateRemoved": "This dismissed candidate was permanently removed and cannot be restored.",
  "candidateRestore": "candidate restore failed",
  "revertFailed": "revert failed",
  "surfaceAction": "action must be opened|hidden|visible|closed",
  "transferFallback": "Transfer assistant unavailable — the memory would move verbatim; edit below if it needs adapting.",
  "traceUnlabeled": "not labeled by trace model",
  "selectionFailed": "Working-memory selection failed. Select the memories to use and confirm to retry their expected-use planning, or reopen preparation.",
  "settingsEmpty": "Settings file was empty. Using defaults.",
  "settingsInvalid": "Settings file is invalid JSON. Using defaults.",
  "memoryServiceUnavailable": "Memory service is unavailable",
  "preparationUnavailable": "Memory preparation branch is unavailable",
  "memoryProjectUnavailable": "Memory branch project is unavailable",
  "gitInitFailed": "Initialize git failed",
  "gitInitMessage": "Git could not initialize this folder.",
  "ghMissing": "GitHub CLI is not installed.",
  "ghUnauthenticated": "GitHub CLI is not authenticated.",
  "repoNamePrompt": "Enter an owner and repository name.",
  "repoExists": "{{v0}}/{{v1}} already exists.",
  "repoAvailable": "{{v0}}/{{v1}} is available.",
  "repoUnknown": "Could not verify repository availability.",
  "gitInitBeforePublish": "Initialize git before publishing to GitHub.",
  "ghMissingTitle": "GitHub CLI not installed",
  "ghInstall": "Install GitHub CLI (`gh`) to publish from MemoSync.",
  "ghLoginTitle": "GitHub CLI not signed in",
  "ghLogin": "Run `gh auth login` and try again.",
  "repoRequired": "Owner and repository name are required.",
  "ghPublishFailed": "GitHub CLI could not publish this repository.",
  "branchCurrent": "{{v0}} is already up to date with {{v1}}.",
  "mergeBlockedTitle": "Merge blocked",
  "mergeBlocked": "Commit, discard, or stash your local changes before merging.",
  "upToDateTitle": "Already up to date",
  "alreadyMerged": "{{v0}} is already merged into {{v1}}.",
  "branchSwitchCancelled": "Branch switch cancelled",
  "changesKept": "Your current changes were kept on the current branch.",
  "checkoutFailed": "Checkout failed",
  "fetchPrFailed": "Git could not fetch the pull request branch.",
  "switchBranchFailed": "Git could not switch branches.",
  "createBranchFailed": "Create branch failed",
  "branchNameInvalid": "Branch name is not valid.",
  "branchExists": "A local branch named \"{{v0}}\" already exists.",
  "createBranchMessage": "Git could not create the branch.",
  "pushFailed": "Push failed",
  "pullFailed": "Pull failed",
  "noUpstream": "This branch does not have an upstream remote branch configured yet.",
  "mergeConflicts": "{{v0}} {{v1}} from {{v2}} would merge into {{v3}}, but conflicts are expected.",
  "mergePreview": "{{v0}} {{v1}} from {{v2}} will merge into {{v3}}.",
  "mergePreviewFailed": "Could not preview this merge.",
  "partialPush": "A local commit was created, but the push did not complete.",
  "settingsReset": "Some settings were reset to defaults: {{v0}}",
  "reviseFailed": "Sorry — I couldn't process that; the selection is unchanged.",
  "selectionUpdated": "Selection updated."
} as const

export type UiCopyCode = keyof typeof SERVER_UI_COPY
export interface UiTextReference { code: UiCopyCode; params?: Record<string, string | number> }

const patterns = Object.entries(SERVER_UI_COPY).map(([code, template]) => {
  const fields: string[] = []
  const parts = template.split(/({{v\d+}})/g).map((part) => {
    const match = part.match(/^{{(v\d+)}}$/)
    if (match) { fields.push(match[1]); return "([\\s\\S]+?)" }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  })
  return { code: code as UiCopyCode, fields, pattern: new RegExp(`^${parts.join("")}$`) }
}).sort((a, b) => a.fields.length - b.fields.length)

export function describeServerUiText(message: string): UiTextReference | undefined {
  for (const { code, fields, pattern } of patterns) {
    const match = message.match(pattern)
    if (match) return { code, ...(fields.length ? { params: Object.fromEntries(fields.map((field, i) => [field, match[i + 1]])) } : {}) }
  }
  return undefined
}

/** Add codes to HTTP error envelopes without changing their legacy shape. */
export function uiJson(data: unknown, init?: ResponseInit): Response {
  if (data && typeof data === "object" && "error" in data) {
    const error = (data as { error: unknown }).error
    if (typeof error === "string") {
      const uiText = describeServerUiText(error)
      if (uiText) return Response.json({ ...data, uiText }, init)
    } else if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      const uiText = describeServerUiText(error.message)
      if (uiText) return Response.json({ ...data, error: { ...error, uiText } }, init)
    }
  }
  return Response.json(data, init)
}

export interface UiTextFields { uiTextFields?: Partial<Record<"title" | "message" | "warning" | "error", UiTextReference>> }

/** Attach metadata only to product results; never traverse chat/user content. */
export function withUiTextFields<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const fields: NonNullable<UiTextFields["uiTextFields"]> = {}
  for (const field of ["message", "warning", "error", ...(source.ok === false ? ["title"] : [])] as const) {
    const text = source[field]
    if (typeof text !== "string") continue
    const reference = describeServerUiText(text)
    if (reference) fields[field as keyof typeof fields] = reference
  }
  return Object.keys(fields).length ? { ...value, uiTextFields: fields } : value
}
