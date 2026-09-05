export interface SemanticFinding {
  severity: "P1" | "P2";
  title: string;
  body: string;
}

export interface SemanticReviewResult {
  status: "PASS" | "FINDING";
  summary: string;
  findings: SemanticFinding[];
}

export function validateSemanticReview(result: SemanticReviewResult): SemanticReviewResult {
  if (result.status === "PASS" && result.findings.length !== 0) {
    throw new Error("SEMANTIC_REVIEW_INCONSISTENT_PASS");
  }
  if (result.status === "FINDING" && result.findings.length === 0) {
    throw new Error("SEMANTIC_REVIEW_INCONSISTENT_FINDING");
  }
  return result;
}
