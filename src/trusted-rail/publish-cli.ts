import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { publishArtifact, RailStopError } from "./publisher.js";
import type { RailArtifact } from "./artifact.js";

async function main(): Promise<void> {
  const artifactPath = process.env.RAIL_ARTIFACT_PATH || "rail-artifact/artifact.json";
  const resultPath = process.env.RAIL_PUBLISH_RESULT_PATH || "rail-publish/publish-result.json";
  const token = process.env.GITHUB_TOKEN || "";
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as RailArtifact;

  mkdirSync(dirname(resultPath), { recursive: true });
  try {
    const result = await publishArtifact(artifact, token);
    writeFileSync(resultPath, `${JSON.stringify({ status: "PUBLISHED", ...result }, null, 2)}\n`);
    const output = process.env.GITHUB_OUTPUT;
    if (output) {
      writeFileSync(output, `published_head=${result.publishedHeadSha}\npr_number=${result.prNumber}\n`, { flag: "a" });
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    const reason = error instanceof RailStopError ? error.reason : "PUBLISH_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(resultPath, `${JSON.stringify({ status: "STOPPED", reason, message }, null, 2)}\n`);
    const output = process.env.GITHUB_OUTPUT;
    if (output) writeFileSync(output, `stop_reason=${reason}\n`, { flag: "a" });
    console.error(`${reason}: ${message}`);
    process.exitCode = 1;
  }
}

void main();
