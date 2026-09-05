import { createHttpServer } from "./api/app.js";
import { SQLiteProjectRepository } from "./repository/sqlite-project-repository.js";
import { SQLiteTaskRepository } from "./repository/sqlite-task-repository.js";

const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.PROJECT_DB_PATH ?? "data/projects.sqlite";
const server = createHttpServer(
  new SQLiteProjectRepository(databasePath),
  new SQLiteTaskRepository(databasePath),
);

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
