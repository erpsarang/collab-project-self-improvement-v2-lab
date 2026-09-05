import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Task, type TaskStatus } from "../domain/task.js";
import type { TaskRepository } from "./task-repository.js";

type TaskRow = {
  idHex: string;
  projectIdHex: string;
  titleHex: string;
  status: TaskStatus;
};

const sqliteOutputBufferBytes = 4 * 1024 * 1024;
const sqliteBusyTimeoutMs = 5000;
const unsupportedSQLitePathError =
  "PROJECT_DB_PATH must use a plain filesystem path; SQLite file: URIs and connection-scoped paths are not supported";

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function decodeHexText(value: string): string {
  return Buffer.from(value, "hex").toString("utf8");
}

function isUnsupportedSQLitePath(databasePath: string): boolean {
  return databasePath === ""
    || databasePath === ":memory:"
    || databasePath.toLowerCase().startsWith("file:");
}

export class SQLiteTaskRepository implements TaskRepository {
  private readonly ready: Promise<void>;

  constructor(private readonly databasePath: string) {
    if (isUnsupportedSQLitePath(databasePath)) {
      throw new Error(unsupportedSQLitePathError);
    }

    mkdirSync(dirname(databasePath), { recursive: true });
    this.ready = this.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    `).then(() => undefined);
  }

  async save(task: Task): Promise<void> {
    await this.ready;
    await this.execute(`
      INSERT INTO tasks (id, project_id, title, status)
      VALUES (${sqlText(task.id)}, ${sqlText(task.projectId)}, ${sqlText(task.title)}, ${sqlText(task.status)})
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        status = excluded.status;
    `);
  }

  async findByProjectId(projectId: string): Promise<Task[]> {
    await this.ready;
    const output = await this.execute(
      `SELECT hex(id) AS idHex, hex(project_id) AS projectIdHex, hex(title) AS titleHex, status FROM tasks WHERE project_id = ${sqlText(projectId)} ORDER BY rowid;`,
      true,
    );
    const rows = output.trim() === "" ? [] : JSON.parse(output) as TaskRow[];

    return rows.map((row) => new Task(
      decodeHexText(row.idHex),
      decodeHexText(row.projectIdHex),
      decodeHexText(row.titleHex),
      row.status,
    ));
  }

  private execute(sql: string, json = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "sqlite3",
        ["-batch", ...(json ? ["-json"] : []), "--", this.databasePath],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        reject(error);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > sqliteOutputBufferBytes) {
          fail(new Error("sqlite3 output exceeded buffer limit"));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(new Error(stderr || `sqlite3 exited with code ${code ?? "unknown"}`));
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString("utf8"));
      });

      child.stdin.end(`.timeout ${sqliteBusyTimeoutMs}\n${sql}`);
    });
  }
}
