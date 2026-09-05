import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Project } from "../domain/project.js";
import type { ProjectRepository } from "./project-repository.js";

type ProjectRow = {
  id: string;
  name: string;
};

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

export class SQLiteProjectRepository implements ProjectRepository {
  constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.execute(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
  }

  save(project: Project): void {
    this.execute(`
      INSERT INTO projects (id, name)
      VALUES (${sqlText(project.id)}, ${sqlText(project.name)})
      ON CONFLICT(id) DO UPDATE SET name = excluded.name;
    `);
  }

  findById(id: string): Project | undefined {
    const output = this.execute(
      `SELECT id, name FROM projects WHERE id = ${sqlText(id)} LIMIT 1;`,
      true,
    );
    const rows = output.trim() === "" ? [] : JSON.parse(output) as ProjectRow[];
    const row = rows[0];

    return row ? new Project(row.id, row.name) : undefined;
  }

  private execute(sql: string, json = false): string {
    return execFileSync("sqlite3", ["-batch", ...(json ? ["-json"] : []), this.databasePath], {
      encoding: "utf8",
      input: sql,
    });
  }
}
