import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ProjectRepository } from "../repository/project-repository.js";
import { InMemoryTaskRepository, type TaskRepository } from "../repository/task-repository.js";
import { getHealthStatus } from "../service/health-service.js";
import { ProjectNotFoundError, ProjectService } from "../service/project-service.js";
import { TaskService } from "../service/task-service.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const maxRequestBodyBytes = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }

      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

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

function isValidText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() !== ""
    && !value.includes("\0")
    && !hasUnpairedSurrogate(value);
}

export function createHttpServer(
  projectRepository: ProjectRepository,
  taskRepository: TaskRepository = new InMemoryTaskRepository(),
): Server {
  const projectService = new ProjectService(projectRepository);
  const taskService = new TaskService(projectRepository, taskRepository);

  return createServer((request, response) => {
    void handleRequest(request, response, projectService, taskService).catch(() => {
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
  taskService: TaskService,
): Promise<void> {
  let url: URL;

  try {
    url = new URL(request.url ?? "/", "http://localhost");
  } catch {
    sendJson(response, 400, { error: "Bad Request" });
    return;
  }
  const pathname = url.pathname;

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
      || !isValidText(body.name)
    ) {
      sendJson(response, 400, { error: "Project name is required" });
      return;
    }

    const project = await projectService.create(body.name.trim());
    sendJson(response, 201, project);
    return;
  }

  const taskCollectionMatch = pathname.match(/^\/projects\/([^/]+)\/tasks$/);
  if (taskCollectionMatch) {
    let projectId: string;
    try {
      projectId = decodeURIComponent(taskCollectionMatch[1]);
    } catch {
      sendJson(response, 400, { error: "Bad Request" });
      return;
    }

    if (request.method === "POST") {
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
        || !("title" in body)
        || !isValidText(body.title)
      ) {
        sendJson(response, 400, { error: "Task title is required" });
        return;
      }

      try {
        const task = await taskService.create(projectId, body.title.trim());
        sendJson(response, 201, task);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          sendJson(response, 404, { error: "Project not found" });
          return;
        }
        throw error;
      }
      return;
    }

    if (request.method === "GET") {
      const status = url.searchParams.get("status");
      if (status !== null && status !== "TODO" && status !== "DONE") {
        sendJson(response, 400, { error: "Task status must be TODO or DONE" });
        return;
      }

      try {
        sendJson(response, 200, await taskService.listByProject(projectId, status ?? undefined));
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          sendJson(response, 404, { error: "Project not found" });
          return;
        }
        throw error;
      }
      return;
    }
  }

  const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
  if (request.method === "GET" && projectMatch) {
    try {
      const project = await projectService.getById(decodeURIComponent(projectMatch[1]));
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
