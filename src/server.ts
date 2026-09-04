import { createHttpServer } from "./api/app.js";

const port = Number(process.env.PORT ?? 3000);
const server = createHttpServer();

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
