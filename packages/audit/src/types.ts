export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditWriteInput {
  readonly actorType: string;
  readonly actorId?: string;
  readonly action: string;
  readonly resourceId?: string;
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly sourceIpHash?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditEvent {
  readonly sequence: number;
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly actorId?: string;
  readonly action: string;
  readonly resourceId?: string;
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly sourceIpHash?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AuditSink {
  write(input: AuditWriteInput): Promise<void>;
}
