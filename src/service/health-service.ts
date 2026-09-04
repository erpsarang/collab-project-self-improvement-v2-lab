import type { HealthStatus } from "../domain/health.js";

export function getHealthStatus(): HealthStatus {
  return { status: "ok" };
}
