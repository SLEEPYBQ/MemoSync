import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryTopicControl, MemoryTopicResults } from "./MemoryTopicControl"
import { MemoryTopicDirectory } from "./MemoryTopicDirectory"
import { useMemoryTopicStore } from "../../stores/memoryTopicStore"

test("topic control is optional and labels unclassified candidates without accepting them", () => {
  const html = renderToStaticMarkup(<MemoryTopicControl ids={["synthetic-1"]} />)
  expect(html).toContain("Unclassified")
  expect(html).toContain("Topic")
  expect(html).not.toContain(">Accept")
})

test("partial receipts expose every result and a failed-only retry", () => {
  const html = renderToStaticMarkup(<MemoryTopicResults result={{ topicId: "t", targetKnown: true, results: [
    { id: "synthetic-success", status: "success" },
    { id: "synthetic-failure", status: "failed", error: "Missing" },
    { id: "synthetic-unprocessed", status: "unprocessed" },
  ] }} busy={false} onRetry={() => {}} />)
  expect(html).toContain("synthetic-success")
  expect(html).toContain("synthetic-failure")
  expect(html).toContain("synthetic-unprocessed")
  expect(html).toContain("Retry failed only (1)")
})

test("persistent directory renders empty topics and affected-count deletion controls", () => {
  const initial = useMemoryTopicStore.getInitialState()
  const original = initial.topics
  initial.topics = [{ id: "synthetic-topic", name: "Empty topic", count: 0 }]
  const html = renderToStaticMarkup(<MemoryTopicDirectory selected="all" onSelect={() => {}} />)
  expect(html).toContain("Empty topic")
  expect(html).toContain("Unclassified")
  expect(html).toContain("Rename Empty topic")
  expect(html).toContain("Delete Empty topic")
  initial.topics = original
})
