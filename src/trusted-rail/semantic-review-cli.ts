import { readFileSync, writeFileSync } from "node:fs";
import { validateSemanticReview, type SemanticReviewResult } from "./semantic-review.js";

const inputPath = process.argv[2] || "semantic-review.json";
const raw = JSON.parse(readFileSync(inputPath, "utf8")) as SemanticReviewResult;
const result = validateSemanticReview(raw);
const output = process.env.GITHUB_OUTPUT;
if (output) {
  writeFileSync(output, `status=${result.status}\n`, { flag: "a" });
}
console.log(result.status);
