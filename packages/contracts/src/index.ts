export const serviceRoles = ["api", "worker"] as const;
export type ServiceRole = (typeof serviceRoles)[number];

export type HealthCheckState = "pass" | "fail" | "disabled";

export interface HealthCheckResult {
  readonly state: HealthCheckState;
  readonly latencyMs?: number;
  readonly detail?: string;
}

export interface HealthResponse {
  readonly status: "ok" | "degraded";
  readonly service: ServiceRole;
  readonly timestamp: string;
  readonly checks: Readonly<Record<string, HealthCheckResult>>;
}

export interface WorkerHeartbeat {
  readonly role: string;
  readonly instanceId: string;
  readonly lastSeenAt: Date;
}
