import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FIX_ATTEMPTS,
  MAX_PUBLISH_RECOVERY_ATTEMPTS,
  normalizeRepositoryPath,
  normalizeAndValidateChangedPaths,
} from "./constants.js";
import { createArtifact, validateArtifact } from "./artifact.js";

const sha = "a".repeat(40);

test("retry budgets remain bounded", () => {
  assert.equal(MAX_FIX_ATTEMPTS, 2);
  assert.equal(MAX_PUBLISH_RECOVERY_ATTEMPTS, 2);
});

test("repository paths are canonicalized and traversal is rejected", () => {
  assert.equal(normalizeRepositoryPath("./src/domain/item.ts"), "src/domain/item.ts");
  assert.equal(normalizeRepositoryPath("src\\domain\\item.ts"), "src/domain/item.ts");
  assert.throws(() => normalizeRepositoryPath("../secret"), /INVALID_PATH/);
  assert.throws(() => normalizeRepositoryPath("C:\\secret"), /INVALID_PATH/);
});

test("trusted rail and verification entrypoints cannot be changed by runtime artifacts", () => {
  assert.throws(() => normalizeAndValidateChangedPaths([".github/workflows/trusted-execution-rail.yml"]), /TRUSTED_AREA_CHANGED/);
  assert.throws(() => normalizeAndValidateChangedPaths(["package.json"]), /TRUSTED_AREA_CHANGED/);
  assert.throws(() => normalizeAndValidateChangedPaths(["scripts/run-tests.js"]), /TRUSTED_AREA_CHANGED/);
});

test("artifact digest is deterministic and detects tampering", () => {
  const content = Buffer.from("export const value = 1;\n");
  const artifact = createArtifact({
    version: 1,
    repository: "owner/repo",
    baseBranch: "main",
    rootBaseSha: sha,
    parentSha: sha,
    targetBranch: "self-improvement/22",
    expectedHeadSha: null,
    issueNumber: 22,
    runId: "run-1",
    changedPaths: ["src/domain/value.ts"],
    files: [{
      path: "src/domain/value.ts",
      operation: "add",
      contentBase64: content.toString("base64"),
      sha256: "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29",
    }],
  });
  assert.equal(validateArtifact(artifact).digest, artifact.digest);
  assert.throws(() => validateArtifact({ ...artifact, digest: "0".repeat(64) }), /ARTIFACT_INTEGRITY_MISMATCH/);
});
