import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_FIX_ATTEMPTS,
  MAX_PUBLISH_RECOVERY_ATTEMPTS,
  normalizeRepositoryPath,
  normalizeAndValidateChangedPaths,
} from "./constants.js";
import { createArtifact, validateArtifact } from "./artifact.js";
import { validateSemanticReview } from "./semantic-review.js";
import { assertArtifactProvenance } from "./publisher.js";

const sha = "a".repeat(40);

test("trusted rail has one label-based human start boundary", () => {
  const workflow = readFileSync(".github/workflows/trusted-execution-rail.yml", "utf8");

  assert.match(workflow, /issues:\n\s+types: \[labeled\]/);
  assert.match(workflow, /label !== 'SI-승인'/);
  assert.match(workflow, /\['write', 'maintain', 'admin'\]/);
  assert.match(workflow, /\/git\/ref\/heads\/main/);
  assert.match(workflow, /self-improvement\/\$\{issue\}/);
  assert.match(workflow, /STOPPED\(DUPLICATE_APPROVAL\)/);
  assert.match(workflow, /STOPPED\(TARGET_BRANCH_EXISTS\)/);
  assert.doesNotMatch(workflow, /workflow_dispatch|trusted-rail-approval|environment:/);
});

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

test("trusted rail roots and descendants cannot be changed by runtime artifacts", () => {
  for (const path of [
    ".github",
    ".github/workflows/trusted-execution-rail.yml",
    "scripts",
    "scripts/run-tests.js",
    "src/trusted-rail",
    "src/trusted-rail/publisher.ts",
    ".trusted-rail",
    ".trusted-rail/artifact.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    assert.throws(() => normalizeAndValidateChangedPaths([path]), /TRUSTED_AREA_CHANGED/);
  }
});

test("semantic review status and findings must be consistent", () => {
  assert.equal(validateSemanticReview({ status: "PASS", summary: "ok", findings: [] }).status, "PASS");
  assert.equal(validateSemanticReview({
    status: "FINDING",
    summary: "needs fix",
    findings: [{ severity: "P1", title: "x", body: "y" }],
  }).status, "FINDING");
  assert.throws(
    () => validateSemanticReview({
      status: "PASS",
      summary: "contradiction",
      findings: [{ severity: "P2", title: "x", body: "y" }],
    }),
    /SEMANTIC_REVIEW_INCONSISTENT_PASS/,
  );
  assert.throws(
    () => validateSemanticReview({ status: "FINDING", summary: "contradiction", findings: [] }),
    /SEMANTIC_REVIEW_INCONSISTENT_FINDING/,
  );
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

test("publisher binds sealed artifact provenance to trusted workflow inputs", () => {
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
  const trusted = {
    repository: "owner/repo",
    baseBranch: "main",
    rootBaseSha: sha,
    parentSha: sha,
    targetBranch: "self-improvement/22",
    expectedHeadSha: null,
    issueNumber: 22,
    runId: "run-1",
  };
  assert.doesNotThrow(() => assertArtifactProvenance(artifact, trusted));
  assert.throws(
    () => assertArtifactProvenance(artifact, { ...trusted, targetBranch: "self-improvement/23" }),
    /Trusted workflow input mismatch for targetBranch/,
  );
});
