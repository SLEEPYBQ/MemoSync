import path from "node:path"
import type { StudyTask } from "../../shared/studyTasks"
import type { RegisteredStudyProject } from "../study-projects"
import { verifyStudyWorkspaceSnapshot } from "../study-workspace-snapshot"
import type { BaselineProjectCopyAdapter } from "./baseline-project-copy"
import {
  copyStaticProjectRepresentation,
  type StaticProjectRepresentationFile,
} from "./static-project-copy"

export interface StaticProjectCopyAdapterManifest extends Record<string, unknown> {
  schemaVersion: 1
  kind: "static_markdown_files"
  transitionKey: string
  outcome: "copied" | "already_present"
  source: {
    taskId: string
    snapshotId: string
    projectId: string
    projectSlug: StudyTask["projectSlug"]
    workspaceTreeHash: string
    representationHash: string
  }
  target: {
    taskId: string
    projectId: string
    projectSlug: StudyTask["projectSlug"]
    representationHash: string
  }
  files: StaticProjectRepresentationFile[]
  totalBytes: number
}

export interface StaticProjectCopyAdapterOptions {
  dataDir: string
  assignedProjects: ReadonlyMap<StudyTask["projectSlug"], RegisteredStudyProject>
}

function studyProjectSlug(value: string): StudyTask["projectSlug"] {
  if (value !== "apartment" && value !== "car") {
    throw new Error(`Static Project Copy received an unknown project slug: ${value}`)
  }
  return value
}

function resolveAssignedProject(
  projects: StaticProjectCopyAdapterOptions["assignedProjects"],
  slug: string,
): { slug: StudyTask["projectSlug"]; project: RegisteredStudyProject } {
  const trustedSlug = studyProjectSlug(slug)
  const project = projects.get(trustedSlug)
  if (!project) throw new Error(`Static Project Copy has no registered study project for ${slug}`)
  return { slug: trustedSlug, project }
}

/**
 * Bind the generic transition gate to Static's immutable workspace evidence.
 * Source and destination paths come only from server-owned study metadata.
 */
export function createStaticProjectCopyAdapter(
  options: StaticProjectCopyAdapterOptions,
): BaselineProjectCopyAdapter {
  return {
    condition: "static",

    async prepare(input) {
      const metadata = input.sourceFreezeRef.workspaceSnapshot
      if (!metadata) throw new Error("Static Project Copy requires a frozen workspace snapshot")
      if (input.sourceFreezeRef.taskId !== input.fromTaskId) {
        throw new Error(`Static Project Copy source freeze does not belong to task ${input.fromTaskId}`)
      }
      const source = resolveAssignedProject(options.assignedProjects, input.fromProjectSlug)
      if (
        metadata.taskId !== input.fromTaskId
        || metadata.snapshotId !== input.sourceFreezeRef.snapshotId
        || metadata.frozenAt !== input.sourceFreezeRef.frozenAt
        || metadata.project.slug !== source.slug
      ) {
        throw new Error("Static Project Copy workspace snapshot metadata does not match the source transition")
      }
      const target = resolveAssignedProject(options.assignedProjects, input.toProjectSlug)
      if (!target.project.starterReady) {
        throw new Error(`Static Project Copy target project is not ready: ${target.slug}`)
      }

      await verifyStudyWorkspaceSnapshot(options.dataDir, metadata)
      const result = await copyStaticProjectRepresentation({
        sourceSnapshotWorkspaceDir: path.resolve(options.dataDir, ...metadata.exportedPath.split("/")),
        destinationWorkspaceDir: target.project.localPath,
      })
      const manifest: StaticProjectCopyAdapterManifest = {
        schemaVersion: 1,
        kind: "static_markdown_files",
        transitionKey: input.transitionKey,
        outcome: result.outcome,
        source: {
          taskId: input.fromTaskId,
          snapshotId: metadata.snapshotId,
          projectId: source.project.projectId,
          projectSlug: source.slug,
          workspaceTreeHash: metadata.treeHash,
          representationHash: result.source.representationHash,
        },
        target: {
          taskId: input.toTaskId,
          projectId: target.project.projectId,
          projectSlug: target.slug,
          representationHash: result.target.representationHash,
        },
        files: result.source.files,
        totalBytes: result.source.totalBytes,
      }
      return {
        sourceRepresentationHash: result.source.representationHash,
        targetRepresentationHash: result.target.representationHash,
        manifest,
      }
    },
  }
}
