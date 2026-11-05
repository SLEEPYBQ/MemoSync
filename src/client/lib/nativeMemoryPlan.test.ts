import { describe, expect, test } from "bun:test"
import type { NativeImportItem, NativeImportOperation, NativeInventoryResult, NativeMemoryUnit, NativeRefineJob } from "../../shared/native-memory"
import type { ProviderCatalogEntry } from "../../shared/types"
import { buildMemoryTree, defaultRefineModel, defaultUnitSelection, estimateRefineTokens, formatTokens, jobProgress, matchesUnitSearch, memoryLines, projectName, proposalScope, reviewModel, selectionBreakdown, summarizeSelection } from "./nativeMemoryPlan"

const unit = (over: Partial<NativeMemoryUnit>): NativeMemoryUnit => ({
  unitId: "u", stableLocator: "l", sourceId: "s", engine: "claude", namespace: "auto:a", title: "t", topic: "topic", kind: "native-memory",
  owner: { scope: "personal" }, scopes: [], unresolvedProject: false, projectLabel: "A", contentHash: "h", parserVersion: "1", linkedMemoryIds: [],
  change: "new", selectedByDefault: true, startLine: 1, endLine: 2, bytes: 40, estimatedTokens: 10, metadata: {}, taskRefs: [], evidenceThreadIds: [],
  correctionSourceIds: [], correctionHash: "", screening: "clear", quarantinedBlocks: 0, ...over,
})
const inventory = (units: NativeMemoryUnit[]): NativeInventoryResult => ({
  roots: [], sources: [], units, groups: [], anomalies: [], skippedEntries: [], estimatedTokens: 0, policy: {} as never,
  counts: { new: 0, changed: 0, unchanged: 0, removed: 0 },
  namespaces: [
    { engine: "codex", namespace: "v1", active: true, activeReason: "", selectedByDefault: true },
    { engine: "codex", namespace: "v2", active: false, activeReason: "", selectedByDefault: false },
  ],
})

describe("memory tree", () => {
  test("folds Claude's per-project namespaces into one section and keeps Codex versions apart", () => {
    const tree = buildMemoryTree(inventory([
      unit({ unitId: "1", namespace: "auto:a", projectLabel: "A" }),
      unit({ unitId: "2", namespace: "auto:b", projectLabel: "B" }),
      unit({ unitId: "3", engine: "codex", namespace: "v2", projectLabel: "A", selectedByDefault: false }),
      unit({ unitId: "4", engine: "codex", namespace: "v1", projectLabel: "A" }),
      unit({ unitId: "5", kind: "skill" }),
    ]))
    expect(tree.map(section => [section.engine, section.namespace, section.units])).toEqual([["claude", null, 2], ["codex", "v1", 1], ["codex", "v2", 1]])
  })

  test("projects with something new come first", () => {
    const [section] = buildMemoryTree(inventory([
      unit({ unitId: "1", projectLabel: "Quiet", change: "unchanged" }),
      unit({ unitId: "2", projectLabel: "Busy", change: "changed" }),
    ]))
    expect(section!.groups.map(group => group.label)).toEqual(["Busy", "Quiet"])
  })
})

describe("default selection", () => {
  const units = [
    unit({ unitId: "new" }), unit({ unitId: "changed", change: "changed" }), unit({ unitId: "same", change: "unchanged" }),
    unit({ unitId: "gone", change: "removed" }), unit({ unitId: "v2", selectedByDefault: false }), unit({ unitId: "rule", kind: "project-rule" }),
    unit({ unitId: "project", owner: { scope: "project", projectId: "p" } }),
  ]
  test("takes only what still needs importing", () => {
    expect([...defaultUnitSelection(inventory(units))].sort()).toEqual(["changed", "new", "project"])
  })
  test("narrows to the open project when it has anything", () => {
    expect([...defaultUnitSelection(inventory(units), "p")]).toEqual(["project"])
    expect(defaultUnitSelection(inventory(units), "other").size).toBe(3)
  })
})

test("search covers title, topic and project", () => {
  expect(matchesUnitSearch(unit({ title: "Release notes" }), "release")).toBe(true)
  expect(matchesUnitSearch(unit({ projectLabel: "MemoSync" }), "memosync")).toBe(true)
  expect(matchesUnitSearch(unit({}), "absent")).toBe(false)
})

test("selection summary counts only what is chosen", () => {
  const units = [unit({ unitId: "a" }), unit({ unitId: "b", change: "changed", estimatedTokens: 5 }), unit({ unitId: "c" })]
  expect(summarizeSelection(units, new Set(["a", "b"]))).toEqual({ total: 2, added: 1, changed: 1, tokens: 15 })
})

describe("default refinement model", () => {
  const provider = (id: string, models: string[], connection?: string) => ({ id, defaultModel: models[0], models: models.map(model => ({ id: model, label: model, connectionId: connection })) }) as unknown as ProviderCatalogEntry
  test("prefers the Codex bulk model, then Haiku", () => {
    expect(defaultRefineModel([provider("claude", ["opus", "haiku"]), provider("codex", ["gpt-6.1-sol", "gpt-6-luna"])])).toEqual({ provider: "codex", model: "gpt-6-luna" })
    expect(defaultRefineModel([provider("claude", ["opus", "haiku"])])).toEqual({ provider: "claude", model: "haiku" })
  })
  test("ignores a connection's model of the same family", () => {
    expect(defaultRefineModel([provider("claude", ["sonnet"]), provider("codex", ["luna-proxy"], "c1")])).toEqual({ provider: "claude", model: "sonnet" })
  })
})

test("job progress adds usage across batches", () => {
  const job = { batches: [
    { state: "completed", droppedQuotes: 1, usage: { inputTokens: 100, outputTokens: 20 } },
    { state: "failed", droppedQuotes: 0 }, { state: "pending", droppedQuotes: 0 },
  ] } as unknown as NativeRefineJob
  expect(jobProgress(job)).toMatchObject({ finished: 1, failed: 1, total: 3, tokens: 120, droppedQuotes: 1 })
})

test("a unit split across batches counts as done only when all of them are", () => {
  const job = { batches: [
    { state: "completed", droppedQuotes: 0, unitIds: ["a", "b"] },
    { state: "running", droppedQuotes: 0, unitIds: ["b", "c"] },
  ] } as unknown as NativeRefineJob
  expect(jobProgress(job)).toMatchObject({ unitsDone: 1, units: 3 })
})

describe("review model", () => {
  const item = (itemKey: string, unitId: string, over: Partial<NativeImportItem> = {}) => ({ itemKey, unitId, owner: { scope: "project", projectId: "p" }, projectLabel: "/x/MemoSync", disposition: "new", ...over }) as NativeImportItem
  const operation = (items: NativeImportItem[], units: NativeMemoryUnit[]) => ({ plan: { operationId: "op", items, units } }) as unknown as NativeImportOperation
  const units = [
    unit({ unitId: "dispatch", title: "codex-dispatch", metadata: { description: "How to dispatch Codex" } }),
    unit({ unitId: "group", title: "Task 1", metadata: { keywords: "- parser\n- schema\n" } }),
    unit({ unitId: "lost", title: "orphan", unresolvedProject: true }),
  ]
  const items = [
    item("a", "dispatch"), item("b", "dispatch"), item("c", "group"),
    item("me", "dispatch", { owner: { scope: "personal" }, projectLabel: undefined }),
    item("upd", "dispatch", { disposition: "changed" }),
    item("pii", "group", { flags: ["personal-info"] }),
    item("orphan", "lost", { owner: { scope: "personal" }, projectLabel: undefined }),
  ]

  test("orders by consequence and stacks project memory by source", () => {
    const model = reviewModel([operation(items, units)])
    expect(model.attention.map(entry => entry.item.itemKey)).toEqual(["upd", "pii"])
    expect(model.personal.flatMap(source => source.entries).map(entry => entry.item.itemKey)).toEqual(["me"])
    expect(model.projects.map(project => [project.label, project.count, project.unattributed])).toEqual([["/x/MemoSync", 3, false], ["A", 1, true]])
    expect(model.projects[0]!.sources.map(source => [source.title, source.summary, source.entries.length])).toEqual([["codex-dispatch", "How to dispatch Codex", 2], ["Task 1", "parser · schema", 1]])
  })

  test("moving and removing take effect at once", () => {
    const model = reviewModel([operation(items, units)], { a: "personal" }, new Set(["b"]))
    expect(model.personal.flatMap(source => source.entries).map(entry => entry.item.itemKey)).toEqual(["a", "me"])
    expect(model.projects[0]!.sources.map(source => source.title)).toEqual(["Task 1"])
    expect(model.projects[0]!.count).toBe(1)
  })
})

test("project paths show their last segment", () => {
  expect(projectName("/Users/me/Developer/MemoSync")).toBe("MemoSync")
  expect(projectName("C:\\work\\app\\")).toBe("app")
  expect(projectName("MemoSync")).toBe("MemoSync")
  expect(projectName("/a/first · /b/second")).toBe("first · second")
})

test("the breakdown lists only projects in the selection, largest first", () => {
  const tree = buildMemoryTree(inventory([unit({ unitId: "a", projectLabel: "A" }), unit({ unitId: "b", projectLabel: "B" }), unit({ unitId: "c", projectLabel: "B" }), unit({ unitId: "d", projectLabel: "C" })]))
  expect(selectionBreakdown(tree, new Set(["a", "b", "c"])).map(row => [row.group.label, row.count])).toEqual([["B", 2], ["A", 1]])
})

test("the estimate pays the fixed prefix once per batch, per project", () => {
  const units = [unit({ unitId: "a", estimatedTokens: 1000 }), unit({ unitId: "b", estimatedTokens: 1000 }), unit({ unitId: "c", projectLabel: "B", estimatedTokens: 25_000 })]
  expect(estimateRefineTokens(units, new Set(["a", "b"]))).toBe(14_000)
  expect(estimateRefineTokens(units, new Set(["c"]))).toBe(61_000)
})

test("a multi-path Codex group sits under its first project", () => {
  const scope = (label: string) => ({ path: label, label, verifiedBy: "applies_to" as const })
  const [section] = buildMemoryTree(inventory([
    unit({ unitId: "a", projectLabel: "/x/app · /y/lib", scopes: [scope("/x/app"), scope("/y/lib")] }),
    unit({ unitId: "b", projectLabel: "/x/app", scopes: [scope("/x/app")] }),
  ]))
  expect(section!.groups.map(group => [group.label, group.units.length])).toEqual([["/x/app", 2]])
})

test("token counts stay readable", () => {
  expect(formatTokens(72000, "en")).toBe("72K")
})

describe("memoryLines", () => {
  test("keeps a refined claim as one line", () => {
    expect(memoryLines("Run focused tests before the full suite.")).toEqual([{ kind: "text", text: "Run focused tests before the full suite." }])
  })
  test("drops the repeated source and Markdown markers from a verbatim import", () => {
    expect(memoryLines("topics/release.md\n\n# Release\n\n- Ask for approval before merging.\n2. Tag after CI", ["topics/release.md\ntopics/release.md", "topics/release.md"])).toEqual([
      { kind: "heading", text: "Release" },
      { kind: "item", text: "Ask for approval before merging." },
      { kind: "item", text: "Tag after CI" },
    ])
  })
  test("never empties a claim that only repeats its source", () => {
    expect(memoryLines("Release", ["Release"])).toEqual([{ kind: "text", text: "Release" }])
  })
})

describe("proposalScope", () => {
  test("a personal proposal stays personal while keeping its project path for moving back", () => {
    const item = { itemKey: "k", owner: { scope: "personal" }, projectPath: "/work/app" } as unknown as NativeImportItem
    expect(proposalScope(item, {})).toBe("personal")
    expect(proposalScope(item, { k: "project" })).toBe("project")
  })
})
