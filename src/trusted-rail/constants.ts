export const MAX_FIX_ATTEMPTS = 2;
export const MAX_PUBLISH_RECOVERY_ATTEMPTS = 2;

export const TRUSTED_PATHS = [
  ".trusted-rail/",
  ".github/",
  "package.json",
  "package-lock.json",
  "scripts/",
  "src/trusted-rail/",
  "docs/trusted-execution-rail.md",
  "tsconfig.json",
] as const;

export function normalizeRepositoryPath(input: string): string {
  if (!input || input.includes("\0")) {
    throw new Error("INVALID_PATH");
  }
  if (/^[A-Za-z]:[\\/]/.test(input) || input.startsWith("/") || input.startsWith("\\")) {
    throw new Error("INVALID_PATH");
  }

  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("INVALID_PATH");
  }
  return normalized;
}

export function isTrustedPath(input: string): boolean {
  const path = normalizeRepositoryPath(input);
  return TRUSTED_PATHS.some((trusted) => {
    if (!trusted.endsWith("/")) return path === trusted;
    const root = trusted.slice(0, -1);
    return path === root || path.startsWith(trusted);
  });
}

export function normalizeAndValidateChangedPaths(paths: string[]): string[] {
  const normalized = paths.map(normalizeRepositoryPath);
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new Error("DUPLICATE_PATH");
  }
  const trusted = normalized.find(isTrustedPath);
  if (trusted) {
    throw new Error(`TRUSTED_AREA_CHANGED:${trusted}`);
  }
  return [...normalized].sort();
}
