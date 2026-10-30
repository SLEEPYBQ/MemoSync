import { t } from "./index"
import { en, zhCN } from "./resources"
import { describeServerUiText, type UiTextReference, type UiCopyCode, type UiTextFields } from "../../shared/ui-copy"

const serverKeys = {
  "newChat": "errors:serverNewChat",
  "forkedChat": "errors:serverForkedChat",
  "projectNotFound": "errors:serverProjectNotFound",
  "chatNotFound": "errors:serverChatNotFound",
  "unavailable": "errors:serverUnavailable",
  "invalidJson": "errors:serverInvalidJson",
  "invalidEnvelope": "errors:serverInvalidEnvelope",
  "unauthorized": "errors:serverUnauthorized",
  "internalServerError": "errors:serverInternalServerError",
  "updateUnavailable": "errors:serverUpdateUnavailable",
  "mergeUnavailable": "errors:serverMergeUnavailable",
  "mergePreviewUnavailable": "errors:serverMergePreviewUnavailable",
  "publishFailed": "errors:serverPublishFailed",
  "mergeFailed": "errors:serverMergeFailed",
  "providerValidationUnavailable": "errors:serverProviderValidationUnavailable",
  "skillSourceInvalid": "errors:serverSkillSourceInvalid",
  "skillIdInvalid": "errors:serverSkillIdInvalid",
  "skillSearchFailed": "errors:serverSkillSearchFailed",
  "skillCliFailed": "errors:serverSkillCliFailed",
  "uploadCount": "errors:serverUploadCount",
  "uploadFileSize": "errors:serverUploadFileSize",
  "uploadTotalSize": "errors:serverUploadTotalSize",
  "uploadTooLarge": "errors:serverUploadTooLarge",
  "uploadUnreadable": "errors:serverUploadUnreadable",
  "uploadEmpty": "errors:serverUploadEmpty",
  "uploadMetadata": "errors:serverUploadMetadata",
  "uploadMismatch": "errors:serverUploadMismatch",
  "uploadFailed": "errors:serverUploadFailed",
  "attachmentPath": "errors:serverAttachmentPath",
  "attachmentNotFound": "errors:serverAttachmentNotFound",
  "projectFilePath": "errors:serverProjectFilePath",
  "fileNotFound": "errors:serverFileNotFound",
  "fileTooLarge": "errors:serverFileTooLarge",
  "fileWriteFailed": "errors:serverFileWriteFailed",
  "fileTargetInvalid": "errors:serverFileTargetInvalid",
  "inactiveChat": "errors:serverInactiveChat",
  "unsupportedAudit": "errors:serverUnsupportedAudit",
  "memoryNotVisible": "errors:serverMemoryNotVisible",
  "invalidField": "errors:serverInvalidField",
  "stringField": "errors:serverStringField",
  "numberField": "errors:serverNumberField",
  "requiredField": "errors:serverRequiredField",
  "requiredFields": "errors:serverRequiredFields",
  "surfaceInvalid": "errors:serverSurfaceInvalid",
  "invalidAction": "errors:serverInvalidAction",
  "mutedNotFound": "errors:serverMutedNotFound",
  "contentScope": "errors:serverContentScope",
  "projectScope": "errors:serverProjectScope",
  "sessionScope": "errors:serverSessionScope",
  "memoryIds": "errors:serverMemoryIds",
  "keepIds": "errors:serverKeepIds",
  "memoryNotFound": "errors:serverMemoryNotFound",
  "rollbackFailed": "errors:serverRollbackFailed",
  "auditUnavailable": "errors:serverAuditUnavailable",
  "flagActiveOnly": "errors:serverFlagActiveOnly",
  "revisionService": "errors:serverRevisionService",
  "noFix": "errors:serverNoFix",
  "injectionService": "errors:serverInjectionService",
  "workingMemoryInactive": "errors:serverWorkingMemoryInactive",
  "usePlanService": "errors:serverUsePlanService",
  "maintenanceUnavailable": "errors:serverMaintenanceUnavailable",
  "kindInvalid": "errors:serverKindInvalid",
  "redundantOther": "errors:serverRedundantOther",
  "mergeKeep": "errors:serverMergeKeep",
  "mergeMoved": "errors:serverMergeMoved",
  "redundantFailed": "errors:serverRedundantFailed",
  "keepArchive": "errors:serverKeepArchive",
  "attentionFailed": "errors:serverAttentionFailed",
  "sanitizeService": "errors:serverSanitizeService",
  "sanitizeFailed": "errors:serverSanitizeFailed",
  "transferInactive": "errors:serverTransferInactive",
  "sourceVersion": "errors:serverSourceVersion",
  "sourceChanged": "errors:serverSourceChanged",
  "targetSession": "errors:serverTargetSession",
  "targetProject": "errors:serverTargetProject",
  "landingRoute": "errors:serverLandingRoute",
  "landingTarget": "errors:serverLandingTarget",
  "landingVersion": "errors:serverLandingVersion",
  "selfLanding": "errors:serverSelfLanding",
  "landingChanged": "errors:serverLandingChanged",
  "landingOutside": "errors:serverLandingOutside",
  "newLandingTarget": "errors:serverNewLandingTarget",
  "badProjectId": "errors:serverBadProjectId",
  "importScope": "errors:serverImportScope",
  "projectIdRequired": "errors:serverProjectIdRequired",
  "captureMode": "errors:serverCaptureMode",
  "candidateRemoved": "errors:serverCandidateRemoved",
  "candidateRestore": "errors:serverCandidateRestore",
  "revertFailed": "errors:serverRevertFailed",
  "surfaceAction": "errors:serverSurfaceAction",
  "transferFallback": "errors:serverTransferFallback",
  "traceUnlabeled": "errors:serverTraceUnlabeled",
  "selectionFailed": "errors:serverSelectionFailed",
  "settingsEmpty": "errors:serverSettingsEmpty",
  "settingsInvalid": "errors:serverSettingsInvalid",
  "memoryServiceUnavailable": "errors:serverMemoryServiceUnavailable",
  "preparationUnavailable": "errors:serverPreparationUnavailable",
  "memoryProjectUnavailable": "errors:serverMemoryProjectUnavailable",
  "gitInitFailed": "errors:serverGitInitFailed",
  "gitInitMessage": "errors:serverGitInitMessage",
  "ghMissing": "errors:serverGhMissing",
  "ghUnauthenticated": "errors:serverGhUnauthenticated",
  "repoNamePrompt": "errors:serverRepoNamePrompt",
  "repoExists": "errors:serverRepoExists",
  "repoAvailable": "errors:serverRepoAvailable",
  "repoUnknown": "errors:serverRepoUnknown",
  "gitInitBeforePublish": "errors:serverGitInitBeforePublish",
  "ghMissingTitle": "errors:serverGhMissingTitle",
  "ghInstall": "errors:serverGhInstall",
  "ghLoginTitle": "errors:serverGhLoginTitle",
  "ghLogin": "errors:serverGhLogin",
  "repoRequired": "errors:serverRepoRequired",
  "ghPublishFailed": "errors:serverGhPublishFailed",
  "branchCurrent": "errors:serverBranchCurrent",
  "mergeBlockedTitle": "errors:serverMergeBlockedTitle",
  "mergeBlocked": "errors:serverMergeBlocked",
  "upToDateTitle": "errors:serverUpToDateTitle",
  "alreadyMerged": "errors:serverAlreadyMerged",
  "branchSwitchCancelled": "errors:serverBranchSwitchCancelled",
  "changesKept": "errors:serverChangesKept",
  "checkoutFailed": "errors:serverCheckoutFailed",
  "fetchPrFailed": "errors:serverFetchPrFailed",
  "switchBranchFailed": "errors:serverSwitchBranchFailed",
  "createBranchFailed": "errors:serverCreateBranchFailed",
  "branchNameInvalid": "errors:serverBranchNameInvalid",
  "branchExists": "errors:serverBranchExists",
  "createBranchMessage": "errors:serverCreateBranchMessage",
  "pushFailed": "errors:serverPushFailed",
  "pullFailed": "errors:serverPullFailed",
  "noUpstream": "errors:serverNoUpstream",
  "mergeConflicts": "errors:serverMergeConflicts",
  "mergePreview": "errors:serverMergePreview",
  "mergePreviewFailed": "errors:serverMergePreviewFailed",
  "partialPush": "errors:serverPartialPush",
  "settingsReset": "errors:serverSettingsReset",
  "reviseFailed": "errors:serverReviseFailed",
  "selectionUpdated": "errors:serverSelectionUpdated"
} as const satisfies Record<UiCopyCode, string>

export function translateServerUiText(reference: UiTextReference | undefined, fallback: string): string {
  if (!reference || !(reference.code in serverKeys)) return fallback
  const params = reference.params ?? {}
  if (reference.code === "mergePreview" || reference.code === "mergeConflicts") {
    const target = params.v3 === "the current branch" ? t("git:currentBranch") : params.v3
    return t(reference.code === "mergePreview" ? "git:mergeCommits" : "git:mergeConflictingCommits", { count: Number(params.v0), source: params.v2, target })
  }
  return t(serverKeys[reference.code], params)
}

type Namespace = keyof typeof en
type ResourceKey = { [N in Namespace]: `${N}:${keyof (typeof en)[N] & string}` }[Namespace]
// Only call on product UI fields (errors, warnings, receipts). User text and
// model output never pass through this adapter. This also re-renders errors
// that were already stored when the user switches languages.
const fixedCopies = new Map<string, ResourceKey>()
for (const [namespace, entries] of Object.entries(en)) {
  for (const [key, value] of Object.entries(entries)) {
    if (value.includes("{{")) continue
    const resourceKey = `${namespace}:${key}` as ResourceKey
    fixedCopies.set(value, resourceKey)
    const chinese = (zhCN[namespace as Namespace] as Record<string, string>)[key]
    fixedCopies.set(chinese, resourceKey)
  }
}

const templateCopies = [en, zhCN].flatMap((resources) =>
  Object.entries(resources).flatMap(([namespace, entries]) => Object.entries(entries).flatMap(([key, value]) => {
    if (!value.includes("{{") || value.includes("<code>")) return []
    const fields: string[] = []
    const parts = value.split(/({{[^}]+}})/g).map((part) => {
      const field = part.match(/^{{\s*([^},]+)(?:,[^}]*)?}}$/)
      if (field) { fields.push(field[1]); return "([\\s\\S]*?)" }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    })
    return [{ key: `${namespace}:${key}` as ResourceKey, fields, pattern: new RegExp(`^${parts.join("")}$`), specificity: value.replace(/{{[^}]+}}/g, "").length }]
  })),
).sort((a, b) => b.specificity - a.specificity)

export function translateUiText(value: string | null | undefined): string {
  if (value == null) return ""
  const reference = describeServerUiText(value)
  if (reference) return translateServerUiText(reference, value)
  const key = fixedCopies.get(value)
  if (key) return t(key)
  for (const template of templateCopies) {
    const match = value.match(template.pattern)
    if (!match) continue
    const params = Object.fromEntries(template.fields.map((field, i) => [field, field === "count" ? Number(match[i + 1].replaceAll(",", "")) : match[i + 1]]))
    return t(template.key, params)
  }
  if (value.includes("\n")) return value.split("\n").map((line) => translateUiText(line)).join("\n")
  return value
}

export interface HttpUiError {
  error?: string | { message?: string; uiText?: UiTextReference }
  uiText?: UiTextReference
}
export function httpUiError(payload: HttpUiError | null | undefined, fallback: string): string {
  const error = payload?.error
  if (typeof error === "string") return translateServerUiText(payload?.uiText ?? describeServerUiText(error), error)
  if (error?.message) return translateServerUiText(error.uiText ?? describeServerUiText(error.message), error.message)
  return fallback
}


/** Only server-marked default titles are UI copy; user/model titles stay verbatim. */
export function chatTitle(chat: { title: string; titleUiText?: UiTextReference }): string {
  return translateServerUiText(chat.titleUiText, chat.title)
}

export function localizeUiResult<T>(value: T): T {
  if (!value || typeof value !== "object" || !("uiTextFields" in value)) return value
  const refs = (value as UiTextFields).uiTextFields
  const result = { ...value } as Record<string, unknown>
  for (const [field, reference] of Object.entries(refs ?? {})) {
    if (typeof result[field] === "string") result[field] = translateServerUiText(reference, result[field])
  }
  return result as T
}
