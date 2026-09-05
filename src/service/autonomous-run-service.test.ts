import assert from "node:assert/strict";
import test from "node:test";

import type {
  ChangeResult,
  SemanticReviewResult,
  VerificationResult,
} from "../domain/autonomous-run.js";
import {
  AutonomousRunService,
  type AutonomousRunActions,
} from "./autonomous-run-service.js";

const candidate = { issueNumber: 16, baseSha: "base-sha" };

const makeActions = (overrides: Partial<AutonomousRunActions> = {}): AutonomousRunActions => {
  const defaults: AutonomousRunActions = {
    plan: async () => undefined,
    implement: async () => ({ changed: true, changedPaths: ["src/example.ts"] }),
    verify: async () => ({ status: "PASS" }),
    publish: async () => ({
      publishedHeadSha: "published-sha",
      changedPaths: ["src/example.ts"],
    }),
    semanticReview: async (_candidate, publishedHeadSha) => ({
      status: "PASS",
      reviewedHeadSha: publishedHeadSha,
    }),
    fix: async () => ({ changed: true, changedPaths: ["src/example.ts"] }),
  };
  return { ...defaults, ...overrides };
};

const createService = (actions: AutonomousRunActions): AutonomousRunService =>
  new AutonomousRunService(actions, () => "2026-09-06T00:00:00.000Z", () => "run-1");

test("successful run verifies the published HEAD before MERGE_READY", async () => {
  const verifiedHeads: Array<string | undefined> = [];
  const result = await createService(makeActions({
    verify: async (_candidate, publishedHeadSha) => {
      verifiedHeads.push(publishedHeadSha);
      return { status: "PASS" };
    },
  })).run(candidate);

  assert.equal(result.state, "MERGE_READY");
  assert.equal(result.provenance.runId, "run-1");
  assert.equal(result.provenance.candidateIssueNumber, 16);
  assert.equal(result.provenance.baseSha, "base-sha");
  assert.equal(result.provenance.publishedHeadSha, "published-sha");
  assert.deepEqual(verifiedHeads, [undefined, "published-sha"]);
  assert.deepEqual(result.provenance.history.map((entry) => entry.state), [
    "PLAN", "IMPLEMENT", "VERIFY", "PUBLISH", "VERIFY", "SEMANTIC_REVIEW", "MERGE_READY",
  ]);
});

test("semantic finding automatically enters FIX and re-runs verify/publish/review", async () => {
  const reviews: SemanticReviewResult[] = [
    { status: "FINDING", reviewedHeadSha: "head-1", findingKey: "finding-1" },
    { status: "PASS", reviewedHeadSha: "head-2" },
  ];
  const heads = ["head-1", "head-2"];
  const result = await createService(makeActions({
    publish: async () => ({
      publishedHeadSha: heads.shift()!,
      changedPaths: ["src/example.ts"],
    }),
    semanticReview: async () => reviews.shift()!,
  })).run(candidate);

  assert.equal(result.state, "MERGE_READY");
  assert.equal(result.provenance.fixAttempt, 1);
  assert.equal(result.provenance.semanticReviewResults.length, 2);
});

test("verification failure automatically enters FIX before publish", async () => {
  const verifications: VerificationResult[] = [
    { status: "FAIL", summary: "tests failed" },
    { status: "PASS" },
    { status: "PASS" },
  ];
  const result = await createService(makeActions({
    verify: async () => verifications.shift()!,
  })).run(candidate);

  assert.equal(result.state, "MERGE_READY");
  assert.equal(result.provenance.fixAttempt, 1);
});

test("failed published-artifact verification enters bounded FIX and republishes", async () => {
  const heads = ["head-1", "head-2"];
  const publishedVerificationResults: VerificationResult[] = [
    { status: "FAIL", summary: "published artifact failed" },
    { status: "PASS" },
  ];
  let publishCalls = 0;
  const result = await createService(makeActions({
    publish: async () => {
      publishCalls += 1;
      return { publishedHeadSha: heads.shift()!, changedPaths: ["src/example.ts"] };
    },
    verify: async (_candidate, publishedHeadSha) => {
      if (!publishedHeadSha) return { status: "PASS" };
      return publishedVerificationResults.shift()!;
    },
    semanticReview: async (_candidate, publishedHeadSha) => ({
      status: "PASS",
      reviewedHeadSha: publishedHeadSha,
    }),
  })).run(candidate);

  assert.equal(result.state, "MERGE_READY");
  assert.equal(result.provenance.fixAttempt, 1);
  assert.equal(publishCalls, 2);
  assert.equal(result.provenance.publishedHeadSha, "head-2");
});

test("unavailable verification stops the run", async () => {
  const result = await createService(makeActions({
    verify: async () => ({ status: "UNAVAILABLE" }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "VERIFICATION_UNAVAILABLE");
});

test("unavailable published-artifact verification stops the run", async () => {
  const result = await createService(makeActions({
    verify: async (_candidate, publishedHeadSha) =>
      publishedHeadSha ? { status: "UNAVAILABLE" } : { status: "PASS" },
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "VERIFICATION_UNAVAILABLE");
});

test("trusted implementation path stops the run", async () => {
  const result = await createService(makeActions({
    implement: async () => ({ changed: true, changedPaths: ["tests/trusted.test.ts"] }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "TRUSTED_AREA_CHANGED");
});

test("co-located src test file is treated as trusted", async () => {
  const result = await createService(makeActions({
    implement: async () => ({
      changed: true,
      changedPaths: ["src/service/autonomous-run-service.test.ts"],
    }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "TRUSTED_AREA_CHANGED");
});

test("verification entrypoints are treated as trusted", async () => {
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", "scripts/run-tests.js"]) {
    const result = await createService(makeActions({
      implement: async () => ({ changed: true, changedPaths: [path] }),
    })).run(candidate);

    assert.equal(result.state, "STOPPED");
    assert.equal(result.provenance.stopReason, "TRUSTED_AREA_CHANGED");
  }
});

test("trusted path introduced by publish stops before published verification", async () => {
  const verifiedHeads: Array<string | undefined> = [];
  const result = await createService(makeActions({
    verify: async (_candidate, publishedHeadSha) => {
      verifiedHeads.push(publishedHeadSha);
      return { status: "PASS" };
    },
    publish: async () => ({
      publishedHeadSha: "published-sha",
      changedPaths: ["src/example.ts", "scripts/run-tests.js"],
    }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "TRUSTED_AREA_CHANGED");
  assert.deepEqual(verifiedHeads, [undefined]);
});

test("undeclared path introduced by publish stops before published verification", async () => {
  const verifiedHeads: Array<string | undefined> = [];
  const result = await createService(makeActions({
    verify: async (_candidate, publishedHeadSha) => {
      verifiedHeads.push(publishedHeadSha);
      return { status: "PASS" };
    },
    publish: async () => ({
      publishedHeadSha: "published-sha",
      changedPaths: ["src/example.ts", "src/undeclared.ts"],
    }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "PUBLISHED_ARTIFACT_PATH_MISMATCH");
  assert.deepEqual(verifiedHeads, [undefined]);
});

test("no-op fix stops the run", async () => {
  const result = await createService(makeActions({
    semanticReview: async (_candidate, head) => ({
      status: "FINDING", reviewedHeadSha: head, findingKey: "finding-1",
    }),
    fix: async () => ({ changed: false, changedPaths: [] }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "NO_OP_FIX");
});

test("repeated semantic finding stops instead of looping", async () => {
  const heads = ["head-1", "head-2"];
  const result = await createService(makeActions({
    publish: async () => ({
      publishedHeadSha: heads.shift()!,
      changedPaths: ["src/example.ts"],
    }),
    semanticReview: async (_candidate, head) => ({
      status: "FINDING", reviewedHeadSha: head, findingKey: "same-finding",
    }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "REPEATED_FINDING");
});

test("reviewing a different SHA than published stops the run", async () => {
  const result = await createService(makeActions({
    semanticReview: async () => ({ status: "PASS", reviewedHeadSha: "wrong-sha" }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "PUBLISHED_REVIEW_SHA_MISMATCH");
});

test("empty published HEAD is rejected as provenance mismatch", async () => {
  const result = await createService(makeActions({
    publish: async () => ({ publishedHeadSha: "   ", changedPaths: ["src/example.ts"] }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.match(result.provenance.stopReason ?? "", /^PROVENANCE_MISMATCH/);
});

test("fix budget is capped at two attempts", async () => {
  let fixCalls = 0;
  const result = await createService(makeActions({
    verify: async () => ({ status: "FAIL", summary: "still failing" }),
    fix: async (): Promise<ChangeResult> => {
      fixCalls += 1;
      return { changed: true, changedPaths: ["src/example.ts"] };
    },
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "MAX_FIX_ATTEMPTS_EXCEEDED");
  assert.equal(fixCalls, 2);
  assert.equal(result.provenance.fixAttempt, 2);
});

test("trusted path changed by FIX stops the run", async () => {
  const result = await createService(makeActions({
    semanticReview: async (_candidate, head) => ({
      status: "FINDING", reviewedHeadSha: head, findingKey: "finding-1",
    }),
    fix: async () => ({ changed: true, changedPaths: [".github/workflows/unsafe.yml"] }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "TRUSTED_AREA_CHANGED");
});

test("finding without a stable key stops as undecidable", async () => {
  const result = await createService(makeActions({
    semanticReview: async (_candidate, head) => ({
      status: "FINDING", reviewedHeadSha: head, summary: "needs work",
    }),
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "UNDECIDABLE_REVIEW_FINDING");
});

test("unexpected automation exception is converted to STOPPED", async () => {
  const result = await createService(makeActions({
    plan: async () => { throw new Error("planner unavailable"); },
  })).run(candidate);

  assert.equal(result.state, "STOPPED");
  assert.equal(result.provenance.stopReason, "AUTOMATION_EXCEPTION: planner unavailable");
});
