import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { InMemoryProjectRepository } from "../repository/project-repository.js";
import { getHealthStatus } from "../service/health-service.js";
import { ProjectNotFoundError, ProjectService } from "../service/project-service.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const maxRequestBodyBytes = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(body));
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let bodyTooLarge = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer | string): void => {
      if (bodyTooLarge) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;

      if (totalBytes > maxRequestBodyBytes) {
        bodyTooLarge = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError());
        return;
      }

      chunks.push(buffer);
    };
    const onEnd = (): void => {
      cleanup();

      if (!bodyTooLarge) {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

export function createHttpServer(): Server {
  const projectService = new ProjectService(new InMemoryProjectRepository());

  return createServer((request, response) => {
    void handleRequest(request, response, projectService).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Internal Server Error" });
      } else {
        response.end();
      }
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projectService: ProjectService,
): Promise<void> {
  let pathname: string;

  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    sendJson(response, 400, { error: "Bad Request" });
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, getHealthStatus());
    return;
  }

  if (request.method === "POST" && pathname === "/projects") {
    let body: unknown;

    try {
      body = await readJsonBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { error: "Request body too large" });
        return;
      }

      sendJson(response, 400, { error: "Request body must be valid JSON" });
      return;
    }

    if (
      typeof body !== "object"
      || body === null
      || !("name" in body)
      || typeof body.name !== "string"
      || body.name.trim() === ""
    ) {
      sendJson(response, 400, { error: "Project name is required" });
      return;
    }

    const project = projectService.create(body.name.trim());
    sendJson(response, 201, project);
    return;
  }

  const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
  if (request.method === "GET" && projectMatch) {
    try {
      const project = projectService.getById(decodeURIComponent(projectMatch[1]));
      sendJson(response, 200, project);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        sendJson(response, 404, { error: "Project not found" });
        return;
      }

      if (error instanceof URIError) {
        sendJson(response, 400, { error: "Bad Request" });
        return;
      }

      throw error;
    }
    return;
  }

  sendJson(response, 404, { error: "Not Found" });
}
