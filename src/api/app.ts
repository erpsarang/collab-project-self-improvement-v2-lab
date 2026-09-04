import { createServer, type Server } from "node:http";

import { getHealthStatus } from "../service/health-service.js";

export function createHttpServer(): Server {
  return createServer((request, response) => {
    let pathname: string;

    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Bad Request" }));
      return;
    }

    if (request.method === "GET" && pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(getHealthStatus()));
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not Found" }));
  });
}
