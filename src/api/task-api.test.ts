import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Project } from "../domain/project.js";
import { Task } from "../domain/task.js";
import { InMemoryProjectRepository, type ProjectRepository } from "../repository/project-repository.js";
import { SQLiteProjectRepository } from "../repository/sqlite-project-repository.js";
import { SQLiteTaskRepository } from "../repository/sqlite-task-repository.js";
import { InMemoryTaskRepository, type TaskRepository } from "../repository/task-repository.js";
import { createHttpServer } from "./app.js";

const openServers: ReturnType<typeof createHttpServer>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function startServer(
  projectRepository: ProjectRepository,
  taskRepository: TaskRepository,
): Promise<string> {
  const server = createHttpServer(projectRepository, taskRepository);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
  const server = openServers.pop();
  assert(server);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("POST /projects/:projectId/tasks creates a TODO task", async () => {
  const projects = new InMemoryProjectRepository();
  const tasks = new InMemoryTaskRepository();
  await projects.save(new Project("p1", "Project 1"));
  const baseUrl = await startServer(projects, tasks);

  const response = await fetch(`${baseUrl}/projects/p1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "First task" }),
  });

  assert.equal(response.status, 201);
  const created = await response.json() as { id: string; projectId: string; title: string; status: string };
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.projectId, "p1");
  assert.equal(created.title, "First task");
  assert.equal(created.status, "TODO");
});

test("GET /projects/:projectId/tasks returns only that project's tasks", async () => {
  const projects = new InMemoryProjectRepository();
  const tasks = new InMemoryTaskRepository();
  await projects.save(new Project("p1", "Project 1"));
  await projects.save(new Project("p2", "Project 2"));
  const baseUrl = await startServer(projects, tasks);

  await fetch(`${baseUrl}/projects/p1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "P1 task" }),
  });
  await fetch(`${baseUrl}/projects/p2/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "P2 task" }),
  });

  const response = await fetch(`${baseUrl}/projects/p1/tasks`);
  assert.equal(response.status, 200);
  const listed = await response.json() as Array<{ projectId: string; title: string }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.projectId, "p1");
  assert.equal(listed[0]?.title, "P1 task");
});

for (const storage of ["memory", "sqlite"] as const) {
  test(`GET /projects/:projectId/tasks supports status filters (${storage})`, async () => {
    let projects: ProjectRepository;
    let tasks: TaskRepository;
    if (storage === "sqlite") {
      const directory = mkdtempSync(join(tmpdir(), "tasks-filter-sqlite-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "projects.sqlite");
      projects = new SQLiteProjectRepository(databasePath);
      tasks = new SQLiteTaskRepository(databasePath);
    } else {
      projects = new InMemoryProjectRepository();
      tasks = new InMemoryTaskRepository();
    }
    await projects.save(new Project("p1", "Project 1"));
    await projects.save(new Project("p2", "Project 2"));
    await projects.save(new Project("empty", "Empty project"));
    const todo = new Task("t1", "p1", "Pending task", "TODO");
    const done = new Task("t2", "p1", "Completed task", "DONE");
    for (const task of [
      todo,
      done,
      new Task("t3", "p2", "Other pending task", "TODO"),
      new Task("t4", "p2", "Other completed task", "DONE"),
    ]) {
      await tasks.save(task);
    }
    const baseUrl = await startServer(projects, tasks);

    for (const [query, expected] of [
      ["", [todo, done]],
      ["?status=TODO", [todo]],
      ["?status=DONE", [done]],
    ] as const) {
      const response = await fetch(`${baseUrl}/projects/p1/tasks${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected.map((task) => ({ ...task })));

      const emptyResponse = await fetch(`${baseUrl}/projects/empty/tasks${query}`);
      assert.equal(emptyResponse.status, 200);
      assert.deepEqual(await emptyResponse.json(), []);

      const missingResponse = await fetch(`${baseUrl}/projects/missing/tasks${query}`);
      assert.equal(missingResponse.status, 404);
      assert.deepEqual(await missingResponse.json(), { error: "Project not found" });
    }

    for (const status of ["INVALID", "todo", "done", "", " TODO "]) {
      const response = await fetch(`${baseUrl}/projects/p1/tasks?status=${encodeURIComponent(status)}`);
      assert.equal(response.status, 400);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await response.json(), { error: "Task status must be TODO or DONE" });
    }
  });
}

test("POST /projects/:projectId/tasks rejects a missing project", async () => {
  const baseUrl = await startServer(new InMemoryProjectRepository(), new InMemoryTaskRepository());
  const response = await fetch(`${baseUrl}/projects/missing/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Orphan task" }),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Project not found" });
});

test("GET /projects/:projectId/tasks rejects a missing project", async () => {
  const baseUrl = await startServer(new InMemoryProjectRepository(), new InMemoryTaskRepository());
  const response = await fetch(`${baseUrl}/projects/missing/tasks`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Project not found" });
});

test("POST /projects/:projectId/tasks rejects an invalid title", async () => {
  const projects = new InMemoryProjectRepository();
  await projects.save(new Project("p1", "Project 1"));
  const baseUrl = await startServer(projects, new InMemoryTaskRepository());
  const response = await fetch(`${baseUrl}/projects/p1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: " " }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Task title is required" });
});

test("SQLite-backed tasks remain available after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tasks-api-sqlite-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "projects.sqlite");
  const firstProjects = new SQLiteProjectRepository(databasePath);
  const firstTasks = new SQLiteTaskRepository(databasePath);
  await firstProjects.save(new Project("p1", "Project 1"));
  const firstBaseUrl = await startServer(firstProjects, firstTasks);

  const createResponse = await fetch(`${firstBaseUrl}/projects/p1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Persistent task" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  await stopServer();

  const restartedBaseUrl = await startServer(
    new SQLiteProjectRepository(databasePath),
    new SQLiteTaskRepository(databasePath),
  );
  const listResponse = await fetch(`${restartedBaseUrl}/projects/p1/tasks`);

  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), [created]);
});
