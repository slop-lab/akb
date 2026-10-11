import { expect } from "@playwright/test"
import { type ImportRecord, ImportRecordSchema } from "../../src/contracts/r4/index.ts"

export const LIFECYCLE_TIMESTAMPS = {
  projectCompletedAt: "2026-10-10T13:04:56.123Z",
  projectArchivedAt: "2026-10-10T14:04:56.234Z",
  labelArchivedAt: "2026-10-10T15:04:56.345Z",
  workCompletedAt: "2026-10-10T16:04:56.456Z",
  workArchivedAt: "2026-10-10T17:04:56.567Z",
  relationArchivedAt: "2026-10-10T18:04:56.678Z",
  commentArchivedAt: "2026-10-10T19:04:56.789Z",
  viewArchivedAt: "2026-10-10T20:04:56.891Z",
} as const

export type LifecycleNames = {
  readonly project: string
  readonly work: string
  readonly comment: string
  readonly view: string
}

export function parseNdjson(bytes: Buffer): readonly ImportRecord[] {
  return bytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => ImportRecordSchema.parse(JSON.parse(line)))
}

export function lifecycleNames(records: readonly ImportRecord[]): LifecycleNames {
  const work = records
    .filter((record) => record.kind === "work_item")
    .find(
      (record) =>
        record.completedAt === LIFECYCLE_TIMESTAMPS.workCompletedAt &&
        record.archivedAt === LIFECYCLE_TIMESTAMPS.workArchivedAt,
    )
  if (work === undefined) throw new TypeError("completed archived Work record missing")
  const project = records
    .filter((record) => record.kind === "project")
    .find(
      (record) =>
        record.externalId === work.projectId &&
        record.completedAt === LIFECYCLE_TIMESTAMPS.projectCompletedAt &&
        record.archivedAt === LIFECYCLE_TIMESTAMPS.projectArchivedAt,
    )
  if (project === undefined) throw new TypeError("completed archived Project record missing")
  const comment = records
    .filter((record) => record.kind === "comment")
    .find((record) => record.subjectId === work.externalId)
  if (comment === undefined) throw new TypeError("archived Comment record missing")
  const view = records
    .filter((record) => record.kind === "saved_view")
    .find((record) => record.archivedAt === LIFECYCLE_TIMESTAMPS.viewArchivedAt)
  if (view === undefined) throw new TypeError("archived Saved View record missing")
  return { project: project.name, work: work.title, comment: comment.body, view: view.name }
}

export function lifecycleCopyCount(
  records: readonly ImportRecord[],
  names: LifecycleNames,
): number {
  return lifecycleProjects(records, names).length
}

export function projectCopyCount(records: readonly ImportRecord[], names: LifecycleNames): number {
  return records
    .filter((record) => record.kind === "project")
    .filter((record) => record.name === names.project).length
}

export function projectImportBytes(
  records: readonly ImportRecord[],
  names: LifecycleNames,
): Buffer {
  const manifest = records.find((record) => record.kind === "manifest")
  const project = records
    .filter((record) => record.kind === "project")
    .find((record) => record.name === names.project)
  if (manifest === undefined || project === undefined) {
    throw new TypeError("Project import dependencies missing")
  }
  const participatingSpaceId = project.participatingSpaceIds?.[0]
  const space = records
    .filter((record) => record.kind === "space")
    .find((record) => record.externalId === participatingSpaceId)
  if (space === undefined) throw new TypeError("Project import Space missing")
  return Buffer.from(
    `${[manifest, space, project].map((record) => JSON.stringify(record)).join("\n")}\n`,
  )
}

export function expectProjectCopies(
  records: readonly ImportRecord[],
  names: LifecycleNames,
  expectedCopies: number,
): void {
  const projects = records
    .filter((record) => record.kind === "project")
    .filter((record) => record.name === names.project)
  expect(projects).toHaveLength(expectedCopies)
  for (const project of projects) {
    expect(project.state).toBe("completed")
    expect(project.completedAt).toBe(LIFECYCLE_TIMESTAMPS.projectCompletedAt)
    expect(project.archivedAt).toBe(LIFECYCLE_TIMESTAMPS.projectArchivedAt)
  }
}

export function expectLifecycleGraph(
  records: readonly ImportRecord[],
  names: LifecycleNames,
  expectedCopies: number,
): void {
  const projects = lifecycleProjects(records, names)
  expect(projects).toHaveLength(expectedCopies)
  for (const project of projects) {
    expect(project.state).toBe("completed")
    expect(project.completedAt).toBe(LIFECYCLE_TIMESTAMPS.projectCompletedAt)
    expect(project.archivedAt).toBe(LIFECYCLE_TIMESTAMPS.projectArchivedAt)
    const work = records
      .filter((record) => record.kind === "work_item")
      .find((record) => record.title === names.work && record.projectId === project.externalId)
    expect(work).toBeDefined()
    if (work === undefined) throw new TypeError("round-trip Work record missing")
    expect(work.completedAt).toBe(LIFECYCLE_TIMESTAMPS.workCompletedAt)
    expect(work.archivedAt).toBe(LIFECYCLE_TIMESTAMPS.workArchivedAt)
    const labelId = work.labelIds?.[0]
    const label = records
      .filter((record) => record.kind === "label")
      .find((record) => record.externalId === labelId)
    expect(label?.archivedAt).toBe(LIFECYCLE_TIMESTAMPS.labelArchivedAt)
    const relation = records
      .filter((record) => record.kind === "relation")
      .find((record) => record.toId === work.externalId)
    expect(relation?.relationType).toBe("parent_of")
    expect(relation?.archivedAt).toBe(LIFECYCLE_TIMESTAMPS.relationArchivedAt)
    const parent = records
      .filter((record) => record.kind === "work_item")
      .find((record) => record.externalId === relation?.fromId)
    expect(parent?.projectId).toBe(project.externalId)
    const comment = records
      .filter((record) => record.kind === "comment")
      .find((record) => record.subjectId === work.externalId)
    expect(comment?.body).toBe(names.comment)
    expect(comment?.archivedAt).toBe(LIFECYCLE_TIMESTAMPS.commentArchivedAt)
    const view = records
      .filter((record) => record.kind === "saved_view")
      .find(
        (record) =>
          record.name === names.view &&
          record.definition.filter?.op === "eq" &&
          record.definition.filter.field === "projectId" &&
          record.definition.filter.value === project.externalId,
      )
    expect(view?.archivedAt).toBe(LIFECYCLE_TIMESTAMPS.viewArchivedAt)
  }
}

function lifecycleProjects(records: readonly ImportRecord[], names: LifecycleNames) {
  return records
    .filter((record) => record.kind === "project")
    .filter(
      (project) =>
        project.name === names.project &&
        records
          .filter((record) => record.kind === "work_item")
          .some((record) => record.title === names.work && record.projectId === project.externalId),
    )
}
