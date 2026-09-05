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

class GitHubApi {
  constructor(
    private readonly repository: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `https://api.github.com/repos/${this.repository}${path}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_PUBLISH_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
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
        const retryable = response.status >= 500 || response.status === 429;
        if (!retryable || attempt === MAX_PUBLISH_RECOVERY_ATTEMPTS) {
          const error = new Error(`GITHUB_API_${response.status}:${text}`);
          Object.assign(error, { status: response.status });
          throw error;
        }
        lastError = new Error(`GITHUB_API_${response.status}:${text}`);
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        const status = (e as Error & { status?: number }).status;
        if (status && status < 500 && status !== 429) throw e;
        lastError = e;
        if (attempt === MAX_PUBLISH_RECOVERY_ATTEMPTS) throw e;
      }
    }
    throw lastError ?? new Error("GITHUB_API_FAILED");
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

export async function publishArtifact(
  rawArtifact: RailArtifact,
  token: string,
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

  if (!token) throw new RailStopError("PUBLISH_FAILED", "Missing trusted GitHub token");
  const api = new GitHubApi(artifact.repository, token);

  const baseRef = await api.optionalRef(artifact.baseBranch);
  if (!baseRef || baseRef.object.sha !== artifact.rootBaseSha) {
    throw new RailStopError("PROVENANCE_MISMATCH", "Base branch moved from approved root SHA");
  }

  const targetRef = await api.optionalRef(artifact.targetBranch);
  if (artifact.expectedHeadSha === null) {
    if (targetRef) throw new RailStopError("TARGET_HEAD_MOVED", "Target branch already exists");
    if (artifact.parentSha !== artifact.rootBaseSha) {
      throw new RailStopError("PROVENANCE_MISMATCH", "Fresh publish parent must equal root base SHA");
    }
  } else {
    if (!targetRef || targetRef.object.sha !== artifact.expectedHeadSha) {
      throw new RailStopError("TARGET_HEAD_MOVED", "Target branch does not match expected head");
    }
    if (artifact.parentSha !== artifact.expectedHeadSha) {
      throw new RailStopError("PROVENANCE_MISMATCH", "Fix artifact parent must equal expected head");
    }
  }

  const parent = await api.request<GitCommit>("GET", `/git/commits/${artifact.parentSha}`);
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
    message: `SI #${artifact.issueNumber}: trusted rail publish (${artifact.runId})`,
    tree: tree.sha,
    parents: [artifact.parentSha],
  });

  if (targetRef) {
    await api.request<GitRef>("PATCH", `/git/refs/heads/${encodeURIComponent(artifact.targetBranch)}`, {
      sha: commit.sha,
      force: false,
    });
  } else {
    await api.request<GitRef>("POST", "/git/refs", {
      ref: `refs/heads/${artifact.targetBranch}`,
      sha: commit.sha,
    });
  }

  const [owner] = artifact.repository.split("/");
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${artifact.targetBranch}`,
    base: artifact.baseBranch,
  });
  let pulls = await api.request<PullRequest[]>("GET", `/pulls?${query.toString()}`);
  if (pulls.length > 1) {
    throw new RailStopError("PROVENANCE_MISMATCH", "Duplicate open PRs for target branch");
  }
  if (pulls.length === 0) {
    try {
      const created = await api.request<PullRequest>("POST", "/pulls", {
        title: `SI #${artifact.issueNumber}: autonomous implementation`,
        head: artifact.targetBranch,
        base: artifact.baseBranch,
        body: [
          `Closes #${artifact.issueNumber}`,
          "",
          `Trusted Rail run: ${artifact.runId}`,
          `Artifact digest: ${artifact.digest}`,
          `Published parent: ${artifact.parentSha}`,
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

  const publishedRef = await api.optionalRef(artifact.targetBranch);
  if (!publishedRef || publishedRef.object.sha !== commit.sha) {
    throw new RailStopError("TARGET_HEAD_MOVED", "Published branch head does not equal created commit");
  }

  return {
    publishedHeadSha: commit.sha,
    branchName: artifact.targetBranch,
    prNumber: pulls[0].number,
    artifactDigest: artifact.digest,
    recovered: false,
  };
}
