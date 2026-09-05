export const AUTONOMOUS_RUN_STATES = [
  "PLAN",
  "IMPLEMENT",
  "VERIFY",
  "PUBLISH",
  "SEMANTIC_REVIEW",
  "FIX",
  "MERGE_READY",
  "STOPPED",
] as const;

export type AutonomousRunState = (typeof AUTONOMOUS_RUN_STATES)[number];

export const MAX_FIX_ATTEMPTS = 2;

export type VerificationStatus = "PASS" | "FAIL" | "UNAVAILABLE";
export type SemanticReviewStatus = "PASS" | "FINDING";

export interface CandidateInput {
  issueNumber: number;
  baseSha: string;
}

export interface ChangeResult {
  changed: boolean;
  changedPaths: string[];
}

export interface VerificationResult {
  status: VerificationStatus;
  summary?: string;
}

export interface PublishResult {
  publishedHeadSha: string;
}

export interface SemanticReviewResult {
  status: SemanticReviewStatus;
  reviewedHeadSha: string;
  findingKey?: string;
  summary?: string;
}

export interface RunHistoryEntry {
  state: AutonomousRunState;
  at: string;
  detail?: string;
}

export interface AutonomousRunProvenance {
  candidateIssueNumber: number;
  runId: string;
  baseSha: string;
  publishedHeadSha: string | null;
  fixAttempt: number;
  verificationResults: VerificationResult[];
  semanticReviewResults: SemanticReviewResult[];
  history: RunHistoryEntry[];
  finalState: "MERGE_READY" | "STOPPED" | null;
  stopReason: string | null;
}

export interface AutonomousRunResult {
  state: "MERGE_READY" | "STOPPED";
  provenance: AutonomousRunProvenance;
}
