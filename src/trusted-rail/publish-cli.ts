import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  publishArtifact,
  RailStopError,
  type TrustedPublishContext,
} from "./publisher.js";
import type { RailArtifact } from "./artifact.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
}

function trustedContext(): TrustedPublishContext {
  const expected = process.env.RAIL_EXPECTED_HEAD?.trim() || null;
  const issueNumber = Number(requiredEnv("RAIL_ISSUE_NUMBER"));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("INVALID_ISSUE_NUMBER");
  }
  return {
    repository: requiredEnv("RAIL_REPOSITORY"),
    baseBranch: requiredEnv("RAIL_BASE_BRANCH"),
    rootBaseSha: requiredEnv("RAIL_ROOT_BASE_SHA"),
    parentSha: requiredEnv("RAIL_PARENT_SHA"),
    targetBranch: requiredEnv("RAIL_TARGET_BRANCH"),
    expectedHeadSha: expected,
    issueNumber,
    runId: requiredEnv("RAIL_RUN_ID"),
  };
}

async function main(): Promise<void> {
  const artifactPath = process.env.RAIL_ARTIFACT_PATH || "rail-artifact/artifact.json";
  const resultPath = process.env.RAIL_PUBLISH_RESULT_PATH || "rail-publish/publish-result.json";
  const token = process.env.GITHUB_TOKEN || "";
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as RailArtifact;

  mkdirSync(dirname(resultPath), { recursive: true });
  try {
    const result = await publishArtifact(artifact, token, trustedContext());
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
