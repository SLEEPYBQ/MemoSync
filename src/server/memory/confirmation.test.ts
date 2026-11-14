import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "./db";
import { MemoryStore } from "./MemoryStore";
import { getMemoryConfirmation, memoryConfirmationReasons, recordMemoryConfirmation } from "./confirmation";
import { FileDrift } from "./file-drift";

test("confirmation persists per chat and tracks versions, removals and enforcement", () => {
  const dir = mkdtempSync(join(tmpdir(), "confirmation-test-"));
  const path = join(dir, "memory.sqlite");
  let db = new Database(path);
  try {
    applySchema(db);
    let store = new MemoryStore(db);
    const a = store.create({ content: "Synthetic first rule", scope: "personal", type: "fact" }, { actor: "user" });
    const b = store.create({ content: "Synthetic second rule", scope: "personal", type: "fact" }, { actor: "user" });
    expect(memoryConfirmationReasons([a, b], getMemoryConfirmation(store, "chat-a"), [])).toMatchObject([
      { id: a.id, reason: "first", version: 1 }, { id: b.id, reason: "first", version: 1 },
    ]);
    recordMemoryConfirmation(store, "chat-a", [a, b], []);
    recordMemoryConfirmation(store, "chat-a", [a], []);
    db.close();
    db = new Database(path);
    applySchema(db);
    store = new MemoryStore(db);
    expect(memoryConfirmationReasons([a, b], getMemoryConfirmation(store, "chat-a"), [])).toEqual([]);
    expect(memoryConfirmationReasons([a], getMemoryConfirmation(store, "chat-b"), [])).toMatchObject([{ reason: "first" }]);
    const changed = store.update(a.id, { content: "Revised synthetic rule" }, { actor: "user" });
    expect(memoryConfirmationReasons([changed], getMemoryConfirmation(store, "chat-a"), [])).toMatchObject([
      { reason: "changed", previousVersion: 1, version: 2 },
    ]);
    recordMemoryConfirmation(store, "chat-a", [], [a.id]);
    expect(memoryConfirmationReasons([changed], getMemoryConfirmation(store, "chat-a"), [])).toMatchObject([{ reason: "removed" }]);
    expect(memoryConfirmationReasons([changed], getMemoryConfirmation(store, "chat-a"), [a.id])).toMatchObject([{ reason: "enforced" }]);
    recordMemoryConfirmation(store, "chat-a", [changed], [a.id]);
    expect(memoryConfirmationReasons([changed, b], getMemoryConfirmation(store, "chat-a"), [])).toEqual([]);
    expect(memoryConfirmationReasons([changed], getMemoryConfirmation(store, "chat-a"), [a.id])).toMatchObject([{ reason: "enforced" }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("file drift requires confirmation once per distinct change", () => {
  const dir = mkdtempSync(join(tmpdir(), "confirmation-drift-"));
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const store = new MemoryStore(db);
    const drift = new FileDrift(db, store);
    const file = join(dir, "auth.ts");
    writeFileSync(file, "baseline");
    const item = store.create({ content: "Use auth.ts", scope: "project", projectId: "P1", type: "fact" }, { actor: "user" });
    drift.syncProject("P1", dir);
    recordMemoryConfirmation(store, "chat", [item], [], drift);
    writeFileSync(file, "first changed file");
    drift.syncProject("P1", dir);
    expect(memoryConfirmationReasons([item], getMemoryConfirmation(store, "chat"), [], drift)).toMatchObject([{ reason: "file_changed", files: [{ path: "auth.ts", drift: "changed" }] }]);
    recordMemoryConfirmation(store, "chat", [item], [], drift);
    expect(memoryConfirmationReasons([item], getMemoryConfirmation(store, "chat"), [], drift)).toEqual([]);
    writeFileSync(file, "another changed file with different size");
    drift.syncProject("P1", dir);
    expect(memoryConfirmationReasons([item], getMemoryConfirmation(store, "chat"), [], drift)).toMatchObject([{ reason: "file_changed" }]);
    expect(memoryConfirmationReasons([item], getMemoryConfirmation(store, "chat"), [item.id], drift)).toMatchObject([{ reason: "enforced" }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
