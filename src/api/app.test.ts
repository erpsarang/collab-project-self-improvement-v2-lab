import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { InMemoryProjectRepository, type ProjectRepository } from "../repository/project-repository.js";
import { SQLiteProjectRepository } from "../repository/sqlite-project-repository.js";
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
  repository: ProjectRepository = new InMemoryProjectRepository(),
): Promise<string> {
  const server = createHttpServer(repository);
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

test("GET /health returns the service status", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GET /health with a query string returns the service status", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/health?source=monitor`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("POST /projects creates a project that GET /projects/:id returns", async () => {
  const baseUrl = await startServer();
  const createResponse = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "First project" }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string; name: string };
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.name, "First project");

  const getResponse = await fetch(`${baseUrl}/projects/${created.id}`);
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), created);
});

test("POSTed projects remain available through the API after a SQLite-backed restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-api-sqlite-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "projects.sqlite");
  const firstBaseUrl = await startServer(new SQLiteProjectRepository(databasePath));
  const createResponse = await fetch(`${firstBaseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Restart-safe project" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string; name: string };
  await stopServer();

  const restartedBaseUrl = await startServer(new SQLiteProjectRepository(databasePath));
  const getResponse = await fetch(`${restartedBaseUrl}/projects/${created.id}`);

  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), created);
});

test("GET /projects/:id returns a clear 404 for a missing project", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/projects/missing`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Project not found" });
});

test("POST /projects rejects an invalid project name", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: " " }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Project name is required" });
});

test("POST /projects rejects project names containing NUL", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x\0y" }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Project name is required" });
});

test("POST /projects rejects project names containing an unpaired surrogate", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: String.raw`{"name":"a\uD800b"}`,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Project name is required" });
});

test("SQLite-backed projects at the request limit can be retrieved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "projects-api-sqlite-"));
  temporaryDirectories.push(directory);
  const baseUrl = await startServer(
    new SQLiteProjectRepository(join(directory, "projects.sqlite")),
  );
  const emptyRequestBytes = Buffer.byteLength(JSON.stringify({ name: "" }));
  const name = "x".repeat(1024 * 1024 - emptyRequestBytes);
  const createResponse = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string; name: string };
  const getResponse = await fetch(`${baseUrl}/projects/${created.id}`);

  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), created);
});

test("POST /projects rejects request bodies larger than 1 MiB", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(1024 * 1024) }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body too large" });
});

test("malformed request targets return 400 without stopping the server", async () => {
  const baseUrl = await startServer();
  const { hostname, port } = new URL(baseUrl);
  const rawResponse = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port) });
    let data = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.end("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });

  assert.match(rawResponse, /^HTTP\/1\.1 400 Bad Request\r\n/);

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: "ok" });
});

test("unknown routes return 404", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/unknown`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not Found" });
});
