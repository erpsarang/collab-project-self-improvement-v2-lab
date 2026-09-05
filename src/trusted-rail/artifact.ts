import { createHash } from "node:crypto";
import {
  normalizeAndValidateChangedPaths,
  normalizeRepositoryPath,
} from "./constants.js";

export type ArtifactOperation = "add" | "modify" | "delete";

export interface ArtifactFile {
  path: string;
  operation: ArtifactOperation;
  contentBase64?: string;
  sha256?: string;
}

export interface RailArtifactPayload {
  version: 1;
  repository: string;
  baseBranch: string;
  rootBaseSha: string;
  parentSha: string;
  targetBranch: string;
  expectedHeadSha: string | null;
  issueNumber: number;
  runId: string;
  changedPaths: string[];
  files: ArtifactFile[];
}

export interface RailArtifact extends RailArtifactPayload {
  digest: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalPayload(payload: RailArtifactPayload): RailArtifactPayload {
  const changedPaths = normalizeAndValidateChangedPaths(payload.changedPaths);
  const files = payload.files
    .map((file) => ({ ...file, path: normalizeRepositoryPath(file.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length !== changedPaths.length) {
    throw new Error("PUBLISHED_ARTIFACT_PATH_MISMATCH");
  }
  if (files.some((file, index) => file.path !== changedPaths[index])) {
    throw new Error("PUBLISHED_ARTIFACT_PATH_MISMATCH");
  }
  if (!/^[^/]+\/[^/]+$/.test(payload.repository)) {
    throw new Error("INVALID_REPOSITORY");
  }
  if (payload.baseBranch !== "main") {
    throw new Error("INVALID_BASE_BRANCH");
  }
  if (!payload.targetBranch.startsWith("self-improvement/")) {
    throw new Error("INVALID_TARGET_BRANCH");
  }
  if (!SHA_PATTERN.test(payload.rootBaseSha) || !SHA_PATTERN.test(payload.parentSha)) {
    throw new Error("INVALID_BASE_SHA");
  }
  if (payload.expectedHeadSha !== null && !SHA_PATTERN.test(payload.expectedHeadSha)) {
    throw new Error("INVALID_EXPECTED_HEAD");
  }
  if (!Number.isInteger(payload.issueNumber) || payload.issueNumber <= 0 || !payload.runId.trim()) {
    throw new Error("INVALID_RUN_IDENTITY");
  }

  for (const file of files) {
    if (file.operation === "delete") {
      if (file.contentBase64 !== undefined || file.sha256 !== undefined) {
        throw new Error(`INVALID_DELETE_ENTRY:${file.path}`);
      }
      continue;
    }
    if (!file.contentBase64 || !file.sha256) {
      throw new Error(`MISSING_FILE_CONTENT:${file.path}`);
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (sha256(content) !== file.sha256) {
      throw new Error(`ARTIFACT_INTEGRITY_MISMATCH:${file.path}`);
    }
  }

  return { ...payload, changedPaths, files };
}

export function artifactDigest(payload: RailArtifactPayload): string {
  return sha256(JSON.stringify(canonicalPayload(payload)));
}

export function createArtifact(payload: RailArtifactPayload): RailArtifact {
  const canonical = canonicalPayload(payload);
  return { ...canonical, digest: sha256(JSON.stringify(canonical)) };
}

export function validateArtifact(artifact: RailArtifact): RailArtifact {
  const { digest, ...payload } = artifact;
  const canonical = canonicalPayload(payload);
  const expected = sha256(JSON.stringify(canonical));
  if (digest !== expected) {
    throw new Error("ARTIFACT_INTEGRITY_MISMATCH");
  }
  return { ...canonical, digest };
}
