import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { afterEach, test } from "node:test";

import { createHttpServer } from "./app.js";

const openServers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function startServer(): Promise<string> {
  const server = createHttpServer();
  openServers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
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
