import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Project } from "../domain/project.js";
import { SQLiteProjectRepository } from "./sqlite-project-repository.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("projects remain available after the SQLite repository is recreated", () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-sqlite-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "nested", "projects.sqlite");
  const project = new Project("project-1", "Persistent project");

  new SQLiteProjectRepository(databasePath).save(project);
  const restartedRepository = new SQLiteProjectRepository(databasePath);

  assert.deepEqual(restartedRepository.findById(project.id), project);
  assert.equal(restartedRepository.findById("missing"), undefined);
});

test("SQLite repository preserves project text without interpreting it as SQL", () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-sqlite-"));
  temporaryDirectories.push(directory);
  const repository = new SQLiteProjectRepository(join(directory, "projects.sqlite"));
  const project = new Project("quoted'id", "한글 프로젝트'); DROP TABLE projects; --");

  repository.save(project);

  assert.deepEqual(repository.findById(project.id), project);
});
