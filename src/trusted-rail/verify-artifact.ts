import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { sha256, validateArtifact, type RailArtifact } from "./artifact.js";
import { normalizeAndValidateChangedPaths } from "./constants.js";

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`GIT_FAILED:${args.join(" ")}:${result.stderr}`);
  return result.stdout.trim();
}

export function verifyPublishedArtifact(artifact: RailArtifact, publishedHeadSha: string): void {
  const validated = validateArtifact(artifact);
  if (git(["rev-parse", "HEAD"]) !== publishedHeadSha) {
    throw new Error("PUBLISHED_ARTIFACT_VERIFY_FAILED:HEAD_MISMATCH");
  }
  const paths = git(["diff", "--name-only", "--no-renames", validated.parentSha, publishedHeadSha, "--"])
    .split("\n")
    .filter(Boolean);
  const normalized = normalizeAndValidateChangedPaths(paths);
  if (JSON.stringify(normalized) !== JSON.stringify(validated.changedPaths)) {
    throw new Error("PUBLISHED_ARTIFACT_PATH_MISMATCH");
  }
  for (const file of validated.files) {
    if (file.operation === "delete") {
      if (existsSync(file.path)) throw new Error(`PUBLISHED_ARTIFACT_VERIFY_FAILED:DELETE:${file.path}`);
      continue;
    }
    if (!existsSync(file.path)) throw new Error(`PUBLISHED_ARTIFACT_VERIFY_FAILED:MISSING:${file.path}`);
    if (sha256(readFileSync(file.path)) !== file.sha256) {
      throw new Error(`PUBLISHED_ARTIFACT_VERIFY_FAILED:DIGEST:${file.path}`);
    }
  }
}
