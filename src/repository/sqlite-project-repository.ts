import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Project } from "../domain/project.js";
import type { ProjectRepository } from "./project-repository.js";

type ProjectRow = {
  idHex: string;
  nameHex: string;
};

const sqliteOutputBufferBytes = 4 * 1024 * 1024;
const sqliteBusyTimeoutMs = 5000;

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function decodeHexText(value: string): string {
  return Buffer.from(value, "hex").toString("utf8");
}

export class SQLiteProjectRepository implements ProjectRepository {
  private readonly ready: Promise<void>;

  constructor(private readonly databasePath: string) {
    if (databasePath === ":memory:") {
      throw new Error("PROJECT_DB_PATH=:memory: is not supported; use a file-backed SQLite path");
    }

    mkdirSync(dirname(databasePath), { recursive: true });
    this.ready = this.execute(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `).then(() => undefined);
  }

  async save(project: Project): Promise<void> {
    await this.ready;
    await this.execute(`
      INSERT INTO projects (id, name)
      VALUES (${sqlText(project.id)}, ${sqlText(project.name)})
      ON CONFLICT(id) DO UPDATE SET name = excluded.name;
    `);
  }

  async findById(id: string): Promise<Project | undefined> {
    await this.ready;
    const output = await this.execute(
      `SELECT hex(id) AS idHex, hex(name) AS nameHex FROM projects WHERE id = ${sqlText(id)} LIMIT 1;`,
      true,
    );
    const rows = output.trim() === "" ? [] : JSON.parse(output) as ProjectRow[];
    const row = rows[0];

    return row
      ? new Project(decodeHexText(row.idHex), decodeHexText(row.nameHex))
      : undefined;
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
