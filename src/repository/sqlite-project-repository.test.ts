import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Project } from "../domain/project.js";
import { SQLiteProjectRepository } from "./sqlite-project-repository.js";

const temporaryDirectories: string[] = [];
const temporaryDatabaseFiles: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }

  for (const databaseFile of temporaryDatabaseFiles.splice(0)) {
    rmSync(databaseFile, { force: true });
  }
});

test("SQLite repository rejects connection-scoped database paths immediately", () => {
  const transientPaths = [
    "",
    ":memory:",
    "file::memory:",
    "file::memory:?cache=shared",
    "file::memory:#fragment",
    "file:%3Amemory%3A?cache=shared",
    "file:memdb?mode=memory&cache=shared",
    "file:memdb?cache=shared&mode=memory",
    "file:memdb?mode=MEMORY#fragment",
    "file:memdb?mode%3Dmemory",
  ];

  for (const databasePath of transientPaths) {
    assert.throws(
      () => new SQLiteProjectRepository(databasePath),
      /file-backed SQLite database; connection-scoped SQLite paths are not supported/,
      databasePath,
    );
  }
});

test("projects remain available after the SQLite repository is recreated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-sqlite-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "nested", "projects.sqlite");
  const project = new Project("project-1", "Persistent project");

  await new SQLiteProjectRepository(databasePath).save(project);
  const restartedRepository = new SQLiteProjectRepository(databasePath);

  assert.deepEqual(await restartedRepository.findById(project.id), project);
  assert.equal(await restartedRepository.findById("missing"), undefined);
});

test("SQLite repository preserves project text without interpreting it as SQL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-sqlite-"));
  temporaryDirectories.push(directory);
  const repository = new SQLiteProjectRepository(join(directory, "projects.sqlite"));
  const project = new Project("quoted'id", "한글 프로젝트'); DROP TABLE projects; --");

  await repository.save(project);

  assert.deepEqual(await repository.findById(project.id), project);
});

test("SQLite repository persists project names too large for a process argument", async () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-sqlite-"));
  temporaryDirectories.push(directory);
  const repository = new SQLiteProjectRepository(join(directory, "projects.sqlite"));
  const project = new Project("large-project", "x".repeat(128 * 1024));

  await repository.save(project);

  assert.deepEqual(await repository.findById(project.id), project);
});

test("SQLite repository preserves accepted control characters across reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-sqlite-"));
  temporaryDirectories.push(directory);
  const repository = new SQLiteProjectRepository(join(directory, "projects.sqlite"));
  const project = new Project("control-project", "a\u0001b\u001Fc");

  await repository.save(project);

  assert.deepEqual(await repository.findById(project.id), project);
});

test("SQLite repository accepts a relative database path beginning with a hyphen", async () => {
  const databasePath = `-projects-${process.pid}.sqlite`;
  temporaryDatabaseFiles.push(databasePath);
  const repository = new SQLiteProjectRepository(databasePath);
  const project = new Project("hyphen-path-project", "Hyphen path project");

  await repository.save(project);

  assert.deepEqual(await repository.findById(project.id), project);
});

test("SQLite repository waits for a temporary database lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-sqlite-lock-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "projects.sqlite");
  const repository = new SQLiteProjectRepository(databasePath);
  await repository.save(new Project("seed", "Seed"));

  const locker = spawn("sqlite3", ["-batch", "--", databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("LOCKED")) {
        locker.stdout.off("data", onData);
        resolve();
      }
    };
    locker.stdout.on("data", onData);
    locker.on("error", reject);
    locker.stdin.write("BEGIN IMMEDIATE;\n.print LOCKED\n");
  });

  const project = new Project("locked-project", "Lock tolerant");
  const savePromise = repository.save(project);
  let completed = false;
  void savePromise.then(() => {
    completed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(completed, false);

  locker.stdin.end("COMMIT;\n");
  await savePromise;
  assert.deepEqual(await repository.findById(project.id), project);
});
