import { validateArtifact, type RailArtifact } from "./artifact.js";
import { MAX_PUBLISH_RECOVERY_ATTEMPTS } from "./constants.js";

export type StopReason =
  | "ARTIFACT_INTEGRITY_MISMATCH"
  | "TRUSTED_AREA_CHANGED"
  | "PUBLISHED_ARTIFACT_PATH_MISMATCH"
  | "TARGET_HEAD_MOVED"
  | "PROVENANCE_MISMATCH"
  | "PUBLISH_FAILED";

export class RailStopError extends Error {
  constructor(public readonly reason: StopReason, message: string) {
    super(message);
  }
}

interface GitRef { object: { sha: string } }
interface GitCommit { sha: string; tree: { sha: string } }
interface GitObject { sha: string }
interface PullRequest { number: number; head: { ref: string }; base: { ref: string } }

export interface TrustedPublishContext {
  repository: string;
  baseBranch: string;
  rootBaseSha: string;
  parentSha: string;
  targetBranch: string;
  expectedHeadSha: string | null;
  issueNumber: number;
  runId: string;
}

class GitHubApi {
  constructor(
    private readonly repository: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `https://api.github.com/repos/${this.repository}${path}`;
  }

  private async rawRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return (await response.json()) as T;
    const text = await response.text();
    const error = new Error(`GITHUB_API_${response.status}:${text}`);
    Object.assign(error, { status: response.status });
    throw error;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_PUBLISH_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        return await this.rawRequest<T>(method, path, body);
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        const status = (e as Error & { status?: number }).status;
        const retryable = status === undefined || status >= 500 || status === 429;
        if (!retryable || attempt === MAX_PUBLISH_RECOVERY_ATTEMPTS) throw e;
        lastError = e;
      }
    }
    throw lastError ?? new Error("GITHUB_API_FAILED");
  }

  async requestOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.rawRequest<T>(method, path, body);
  }

  async optionalRef(branch: string): Promise<GitRef | null> {
    try {
      return await this.request<GitRef>("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
    } catch (error) {
      if ((error as Error & { status?: number }).status === 404) return null;
      throw error;
    }
  }
}

export interface PublishResult {
  publishedHeadSha: string;
  branchName: string;
  prNumber: number;
  artifactDigest: string;
  recovered: boolean;
}

export function assertArtifactProvenance(
  artifact: RailArtifact,
  trusted: TrustedPublishContext,
): void {
  const comparisons: Array<[string, unknown, unknown]> = [
    ["repository", artifact.repository, trusted.repository],
    ["baseBranch", artifact.baseBranch, trusted.baseBranch],
    ["rootBaseSha", artifact.rootBaseSha, trusted.rootBaseSha],
    ["parentSha", artifact.parentSha, trusted.parentSha],
    ["targetBranch", artifact.targetBranch, trusted.targetBranch],
    ["expectedHeadSha", artifact.expectedHeadSha, trusted.expectedHeadSha],
    ["issueNumber", artifact.issueNumber, trusted.issueNumber],
    ["runId", artifact.runId, trusted.runId],
  ];
  const mismatch = comparisons.find(([, actual, expected]) => actual !== expected);
  if (mismatch) {
    throw new RailStopError(
      "PROVENANCE_MISMATCH",
      `Trusted workflow input mismatch for ${mismatch[0]}`,
    );
  }
}

export async function publishArtifact(
  rawArtifact: RailArtifact,
  token: string,
  trusted: TrustedPublishContext,
): Promise<PublishResult> {
  let artifact: RailArtifact;
  try {
    artifact = validateArtifact(rawArtifact);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: StopReason = message.startsWith("TRUSTED_AREA_CHANGED")
      ? "TRUSTED_AREA_CHANGED"
      : message.startsWith("PUBLISHED_ARTIFACT_PATH_MISMATCH")
        ? "PUBLISHED_ARTIFACT_PATH_MISMATCH"
        : "ARTIFACT_INTEGRITY_MISMATCH";
    throw new RailStopError(reason, message);
  }

  assertArtifactProvenance(artifact, trusted);

  if (!token) throw new RailStopError("PUBLISH_FAILED", "Missing trusted GitHub token");
  const api = new GitHubApi(trusted.repository, token);

  const baseRef = await api.optionalRef(trusted.baseBranch);
  if (!baseRef || baseRef.object.sha !== trusted.rootBaseSha) {
    throw new RailStopError("PROVENANCE_MISMATCH", "Base branch moved from approved root SHA");
  }

  const initialTargetRef = await api.optionalRef(trusted.targetBranch);
  if (trusted.expectedHeadSha === null) {
    if (initialTargetRef) throw new RailStopError("TARGET_HEAD_MOVED", "Target branch already exists");
    if (trusted.parentSha !== trusted.rootBaseSha) {
      throw new RailStopError("PROVENANCE_MISMATCH", "Fresh publish parent must equal root base SHA");
    }
  } else {
    if (!initialTargetRef || initialTargetRef.object.sha !== trusted.expectedHeadSha) {
      throw new RailStopError("TARGET_HEAD_MOVED", "Target branch does not match expected head");
    }
    if (trusted.parentSha !== trusted.expectedHeadSha) {
      throw new RailStopError("PROVENANCE_MISMATCH", "Fix artifact parent must equal expected head");
    }
  }

  const parent = await api.request<GitCommit>("GET", `/git/commits/${trusted.parentSha}`);
  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }> = [];
  for (const file of artifact.files) {
    if (file.operation === "delete") {
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await api.request<GitObject>("POST", "/git/blobs", {
      content: file.contentBase64,
      encoding: "base64",
    });
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await api.request<GitObject>("POST", "/git/trees", {
    base_tree: parent.tree.sha,
    tree: treeEntries,
  });
  const commit = await api.request<GitObject>("POST", "/git/commits", {
    message: `SI #${trusted.issueNumber}: trusted rail publish (${trusted.runId})`,
    tree: tree.sha,
    parents: [trusted.parentSha],
  });

  // GitHub REST ref updates do not accept an expected-old-SHA CAS value. Re-read
  // immediately before the one-shot mutation, serialize same-target runs at the
  // workflow level, never retry the ref mutation, and verify the exact new HEAD.
  const preUpdateRef = await api.optionalRef(trusted.targetBranch);
  if (trusted.expectedHeadSha === null) {
    if (preUpdateRef) throw new RailStopError("TARGET_HEAD_MOVED", "Target branch appeared before publish");
  } else if (!preUpdateRef || preUpdateRef.object.sha !== trusted.expectedHeadSha) {
    throw new RailStopError("TARGET_HEAD_MOVED", "Target branch moved before publish");
  }

  try {
    if (preUpdateRef) {
      await api.requestOnce<GitRef>("PATCH", `/git/refs/heads/${encodeURIComponent(trusted.targetBranch)}`, {
        sha: commit.sha,
        force: false,
      });
    } else {
      await api.requestOnce<GitRef>("POST", "/git/refs", {
        ref: `refs/heads/${trusted.targetBranch}`,
        sha: commit.sha,
      });
    }
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 409 || status === 422) {
      throw new RailStopError("TARGET_HEAD_MOVED", "Target branch changed during publish mutation");
    }
    throw error;
  }

  const publishedRef = await api.optionalRef(trusted.targetBranch);
  if (!publishedRef || publishedRef.object.sha !== commit.sha) {
    throw new RailStopError("TARGET_HEAD_MOVED", "Published branch head does not equal created commit");
  }

  const [owner] = trusted.repository.split("/");
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${trusted.targetBranch}`,
    base: trusted.baseBranch,
  });
  let pulls = await api.request<PullRequest[]>("GET", `/pulls?${query.toString()}`);
  if (pulls.length > 1) {
    throw new RailStopError("PROVENANCE_MISMATCH", "Duplicate open PRs for target branch");
  }
  if (pulls.length === 0) {
    try {
      const created = await api.request<PullRequest>("POST", "/pulls", {
        title: `SI #${trusted.issueNumber}: autonomous implementation`,
        head: trusted.targetBranch,
        base: trusted.baseBranch,
        body: [
          `Closes #${trusted.issueNumber}`,
          "",
          `Trusted Rail run: ${trusted.runId}`,
          `Artifact digest: ${artifact.digest}`,
          `Published parent: ${trusted.parentSha}`,
          "",
          "Auto Merge is intentionally disabled. Final merge is Human-controlled.",
        ].join("\n"),
      });
      pulls = [created];
    } catch (error) {
      pulls = await api.request<PullRequest[]>("GET", `/pulls?${query.toString()}`);
      if (pulls.length !== 1) throw error;
    }
  }

  return {
    publishedHeadSha: commit.sha,
    branchName: trusted.targetBranch,
    prNumber: pulls[0].number,
    artifactDigest: artifact.digest,
    recovered: false,
  };
}
