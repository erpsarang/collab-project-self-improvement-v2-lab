import { randomUUID } from "node:crypto";

import {
  MAX_FIX_ATTEMPTS,
  type AutonomousRunProvenance,
  type AutonomousRunResult,
  type AutonomousRunState,
  type CandidateInput,
  type ChangeResult,
  type PublishResult,
  type SemanticReviewResult,
  type VerificationResult,
} from "../domain/autonomous-run.js";

export interface AutonomousRunActions {
  plan(candidate: CandidateInput): Promise<void>;
  implement(candidate: CandidateInput): Promise<ChangeResult>;
  verify(candidate: CandidateInput, publishedHeadSha?: string): Promise<VerificationResult>;
  publish(candidate: CandidateInput): Promise<PublishResult>;
  semanticReview(candidate: CandidateInput, publishedHeadSha: string): Promise<SemanticReviewResult>;
  fix(candidate: CandidateInput, reason: string, attempt: number): Promise<ChangeResult>;
}

const isTrustedPath = (path: string): boolean =>
  path === "test" ||
  path.startsWith("test/") ||
  path === "tests" ||
  path.startsWith("tests/") ||
  path.startsWith(".github/") ||
  /(^|\/)src\/.*\.(test|spec)\.[^/]+$/.test(path);

const changedTrustedArea = (change: ChangeResult): boolean =>
  change.changedPaths.some(isTrustedPath);

export class AutonomousRunService {
  constructor(
    private readonly actions: AutonomousRunActions,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createRunId: () => string = () => randomUUID(),
  ) {}

  async run(candidate: CandidateInput): Promise<AutonomousRunResult> {
    const provenance: AutonomousRunProvenance = {
      candidateIssueNumber: candidate.issueNumber,
      runId: this.createRunId(),
      baseSha: candidate.baseSha,
      publishedHeadSha: null,
      fixAttempt: 0,
      verificationResults: [],
      semanticReviewResults: [],
      history: [],
      finalState: null,
      stopReason: null,
    };
    const seenFindings = new Set<string>();

    const transition = (state: AutonomousRunState, detail?: string): void => {
      provenance.history.push({ state, at: this.now(), ...(detail ? { detail } : {}) });
    };

    const stop = (reason: string): AutonomousRunResult => {
      transition("STOPPED", reason);
      provenance.finalState = "STOPPED";
      provenance.stopReason = reason;
      return { state: "STOPPED", provenance };
    };

    const verify = async (publishedHeadSha?: string): Promise<VerificationResult> => {
      transition("VERIFY", publishedHeadSha ? `publishedHeadSha=${publishedHeadSha}` : undefined);
      const result = await this.actions.verify(candidate, publishedHeadSha);
      provenance.verificationResults.push(result);
      return result;
    };

    const applyFix = async (reason: string): Promise<AutonomousRunResult | null> => {
      if (provenance.fixAttempt >= MAX_FIX_ATTEMPTS) {
        return stop("MAX_FIX_ATTEMPTS_EXCEEDED");
      }
      provenance.fixAttempt += 1;
      transition("FIX", `attempt=${provenance.fixAttempt}; reason=${reason}`);
      const change = await this.actions.fix(candidate, reason, provenance.fixAttempt);
      if (!change.changed) {
        return stop("NO_OP_FIX");
      }
      if (changedTrustedArea(change)) {
        return stop("TRUSTED_AREA_CHANGED");
      }
      return null;
    };

    try {
      transition("PLAN");
      await this.actions.plan(candidate);

      transition("IMPLEMENT");
      const implementation = await this.actions.implement(candidate);
      if (changedTrustedArea(implementation)) {
        return stop("TRUSTED_AREA_CHANGED");
      }

      let verification = await verify();
      if (verification.status === "UNAVAILABLE") {
        return stop("VERIFICATION_UNAVAILABLE");
      }

      while (verification.status === "FAIL") {
        const fixResult = await applyFix(`verification:${verification.summary ?? "failed"}`);
        if (fixResult) return fixResult;
        verification = await verify();
        if (verification.status === "UNAVAILABLE") {
          return stop("VERIFICATION_UNAVAILABLE");
        }
      }

      while (true) {
        transition("PUBLISH");
        const publishResult = await this.actions.publish(candidate);
        if (!publishResult.publishedHeadSha.trim()) {
          return stop("PROVENANCE_MISMATCH: publish returned an empty HEAD SHA");
        }
        provenance.publishedHeadSha = publishResult.publishedHeadSha;

        const publishedVerification = await verify(publishResult.publishedHeadSha);
        if (publishedVerification.status === "UNAVAILABLE") {
          return stop("VERIFICATION_UNAVAILABLE");
        }
        if (publishedVerification.status === "FAIL") {
          const fixResult = await applyFix(
            `published-verification:${publishedVerification.summary ?? "failed"}`,
          );
          if (fixResult) return fixResult;

          verification = await verify();
          if (verification.status === "UNAVAILABLE") {
            return stop("VERIFICATION_UNAVAILABLE");
          }
          while (verification.status === "FAIL") {
            const verifyFixResult = await applyFix(`verification:${verification.summary ?? "failed"}`);
            if (verifyFixResult) return verifyFixResult;
            verification = await verify();
            if (verification.status === "UNAVAILABLE") {
              return stop("VERIFICATION_UNAVAILABLE");
            }
          }
          continue;
        }

        transition("SEMANTIC_REVIEW");
        const review = await this.actions.semanticReview(candidate, publishResult.publishedHeadSha);
        provenance.semanticReviewResults.push(review);
        if (review.reviewedHeadSha !== publishResult.publishedHeadSha) {
          return stop("PUBLISHED_REVIEW_SHA_MISMATCH");
        }

        if (review.status === "PASS") {
          transition("MERGE_READY");
          provenance.finalState = "MERGE_READY";
          return { state: "MERGE_READY", provenance };
        }

        const findingKey = review.findingKey?.trim();
        if (!findingKey) {
          return stop("UNDECIDABLE_REVIEW_FINDING");
        }
        if (seenFindings.has(findingKey)) {
          return stop("REPEATED_FINDING");
        }
        seenFindings.add(findingKey);

        const fixResult = await applyFix(`review:${findingKey}`);
        if (fixResult) return fixResult;

        verification = await verify();
        if (verification.status === "UNAVAILABLE") {
          return stop("VERIFICATION_UNAVAILABLE");
        }
        while (verification.status === "FAIL") {
          const verifyFixResult = await applyFix(`verification:${verification.summary ?? "failed"}`);
          if (verifyFixResult) return verifyFixResult;
          verification = await verify();
          if (verification.status === "UNAVAILABLE") {
            return stop("VERIFICATION_UNAVAILABLE");
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return stop(`AUTOMATION_EXCEPTION: ${message}`);
    }
  }
}
