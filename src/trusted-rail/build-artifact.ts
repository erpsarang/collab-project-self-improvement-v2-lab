import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createArtifact, sha256, type ArtifactFile } from "./artifact.js";
import { normalizeAndValidateChangedPaths } from "./constants.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`MISSING_ENV:${name}`);
  return value.trim();
}

function git(args: string[], allowFailure = false): Buffer {
  const result = spawnSync("git", args, { encoding: "buffer" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`GIT_FAILED:${args.join(" ")}:${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

function parentHas(parentSha: string, path: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${parentSha}:${path}`]).status === 0;
}

const repository = env("RAIL_REPOSITORY");
const baseBranch = env("RAIL_BASE_BRANCH");
const rootBaseSha = env("RAIL_ROOT_BASE_SHA");
const parentSha = env("RAIL_PARENT_SHA");
const targetBranch = env("RAIL_TARGET_BRANCH");
const issueNumber = Number(env("RAIL_ISSUE_NUMBER"));
const runId = env("RAIL_RUN_ID");
const outputPath = process.env.RAIL_OUTPUT_PATH?.trim() || "rail-artifact/artifact.json";
const expectedHeadSha = process.env.RAIL_EXPECTED_HEAD?.trim() || null;

const diffPaths = git(["diff", "--name-only", "-z", "--no-renames", parentSha, "--"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const untrackedPaths = git(["ls-files", "--others", "--exclude-standard", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const rawPaths = [...new Set([...diffPaths, ...untrackedPaths])].filter((path) => {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return !normalized.startsWith(".trusted-rail/");
});
const changedPaths = normalizeAndValidateChangedPaths(rawPaths);

if (changedPaths.length === 0) {
  throw new Error("NO_IMPLEMENTATION_CHANGES");
}

const files: ArtifactFile[] = changedPaths.map((path) => {
  const exists = existsSync(path);
  const existedBefore = parentHas(parentSha, path);
  if (!exists && !existedBefore) throw new Error(`UNRESOLVED_PATH:${path}`);
  if (!exists) return { path, operation: "delete" };

  if (lstatSync(path).isSymbolicLink()) throw new Error(`SYMLINK_NOT_ALLOWED:${path}`);
  const root = realpathSync(process.cwd());
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`PATH_ESCAPES_REPOSITORY:${path}`);
  }
  const content = readFileSync(path);
  return {
    path,
    operation: existedBefore ? "modify" : "add",
    contentBase64: content.toString("base64"),
    sha256: sha256(content),
  };
});

const artifact = createArtifact({
  version: 1,
  repository,
  baseBranch,
  rootBaseSha,
  parentSha,
  targetBranch,
  expectedHeadSha,
  issueNumber,
  runId,
  changedPaths,
  files,
});

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
writeFileSync(`${outputPath}.sha256`, `${artifact.digest}\n`, { mode: 0o600 });
console.log(`artifact=${outputPath}`);
console.log(`digest=${artifact.digest}`);
console.log(`changedPaths=${artifact.changedPaths.join(",")}`);
