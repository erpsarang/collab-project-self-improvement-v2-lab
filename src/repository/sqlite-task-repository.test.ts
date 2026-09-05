import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Task } from "../domain/task.js";
import { SQLiteTaskRepository } from "./sqlite-task-repository.js";

test("SQLiteTaskRepository persists tasks and filters by project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-task-repository-"));
  try {
    const databasePath = join(directory, "projects.sqlite");
    const repository = new SQLiteTaskRepository(databasePath);
    await repository.save(new Task("t1", "p1", "한글 task", "TODO"));
    await repository.save(new Task("t2", "p2", "Other task", "DONE"));

    const restarted = new SQLiteTaskRepository(databasePath);
    assert.deepEqual(await restarted.findByProjectId("p1"), [
      new Task("t1", "p1", "한글 task", "TODO"),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
