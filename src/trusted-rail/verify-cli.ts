import { readFileSync } from "node:fs";
import { verifyPublishedArtifact } from "./verify-artifact.js";
import type { RailArtifact } from "./artifact.js";

async function main(): Promise<void> {
  const artifactPath = process.env.RAIL_ARTIFACT_PATH || "rail-artifact/artifact.json";
  const publishedHeadSha = process.env.RAIL_PUBLISHED_HEAD?.trim();
  if (!publishedHeadSha) throw new Error("MISSING_ENV:RAIL_PUBLISHED_HEAD");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as RailArtifact;
  verifyPublishedArtifact(artifact, publishedHeadSha);

  const token = process.env.GITHUB_TOKEN || "";
  if (!token) throw new Error("MISSING_ENV:GITHUB_TOKEN");
  const response = await fetch(
    `https://api.github.com/repos/${artifact.repository}/git/ref/heads/${encodeURIComponent(artifact.targetBranch)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`GITHUB_API_${response.status}:${await response.text()}`);
  const ref = (await response.json()) as { object: { sha: string } };
  if (ref.object.sha !== publishedHeadSha) throw new Error("PUBLISHED_ARTIFACT_VERIFY_FAILED:BRANCH_HEAD");
  console.log(`verified published head ${publishedHeadSha}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
