import type { Readable } from "node:stream";

export interface TelegramIdentity {
  readonly userId: string;
  readonly chatId: string;
  readonly displayName?: string;
}

export interface TelegramBinding extends TelegramIdentity {
  readonly boundAt: Date;
  readonly updatedAt: Date;
}

export interface DropSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly userAgentHash: string;
  readonly telegramUserId: string;
  readonly telegramChatId: string;
  readonly state: "active" | "revoked" | "expired";
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly reservedFiles: number;
  readonly reservedBytes: number;
}

export interface NewDropSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly session: DropSession;
}

export interface DropUpload {
  readonly id: string;
  readonly sessionId: string;
  readonly clientKeyHash: string;
  readonly uploadId?: string;
  readonly resourceId?: string;
  readonly filename: string;
  readonly expectedSize: number;
  readonly expectedSha256?: string;
  readonly state: "reserved" | "uploading" | "completed" | "failed";
  readonly createdAt: Date;
  readonly completedAt?: Date;
}

export interface DropOptions {
  readonly publicOrigin: string;
  readonly codeTtlMs: number;
  readonly linkCodeTtlMs: number;
  readonly sessionTtlMs: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly failureLimit: number;
  readonly globalFailureLimit: number;
  readonly failureWindowMs: number;
  readonly failureDelayMs?: number;
}

export interface DropSessionValidationInput {
  readonly token: string;
  readonly userAgent: string;
  readonly isMutation: boolean;
  readonly origin?: string;
  readonly csrfCookie?: string;
  readonly csrfHeader?: string;
  readonly now?: Date;
}

export interface DropUploadCreateInput {
  readonly filename: string;
  readonly expectedSize: number;
  readonly expectedSha256?: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export interface DropUploadStatus {
  readonly id: string;
  readonly state: DropUpload["state"];
  readonly expectedSize: number;
  readonly receivedSize: number;
  readonly expiresAt: Date;
  readonly completed: boolean;
}

export interface DropCompletion {
  readonly upload: DropUploadStatus;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface DropRepository {
  createLinkChallenge(input: { readonly id: string; readonly codeHash: string; readonly createdAt: Date; readonly expiresAt: Date }): Promise<void>;
  consumeLinkChallenge(codeHash: string, identity: TelegramIdentity, now: Date): Promise<TelegramBinding | undefined>;
  getBinding(): Promise<TelegramBinding | undefined>;
  unlink(now: Date): Promise<{ readonly sessions: number; readonly challenges: number }>;
  createDropChallenge(input: { readonly id: string; readonly codeHash: string; readonly identity: TelegramIdentity; readonly createdAt: Date; readonly expiresAt: Date }): Promise<boolean>;
  redeemDropChallenge(input: { readonly codeHash: string; readonly tokenHash: string; readonly csrfHash: string; readonly userAgentHash: string; readonly sessionId: string; readonly now: Date; readonly expiresAt: Date; readonly maxFiles: number; readonly maxBytes: number }): Promise<DropSession | undefined>;
  beginDropAttempt(input: { readonly sourceIpHash: string; readonly since: Date; readonly sourceLimit: number; readonly globalLimit: number; readonly occurredAt: Date }): Promise<string | undefined>;
  finishDropAttempt(sequence: string, outcome: "success" | "failure", occurredAt: Date): Promise<void>;
  touchDropSession(tokenHash: string, userAgentHash: string, now: Date): Promise<DropSession | undefined>;
  revokeDropSession(tokenHash: string, now: Date): Promise<void>;
  revokeDropAccess(identity: TelegramIdentity, now: Date): Promise<{ readonly sessions: number; readonly challenges: number }>;
  reserveUpload(input: { readonly id: string; readonly sessionId: string; readonly clientKeyHash: string; readonly filename: string; readonly expectedSize: number; readonly expectedSha256?: string; readonly now: Date }): Promise<{ readonly value: DropUpload; readonly created: boolean }>;
  attachUpload(sessionId: string, id: string, uploadId: string): Promise<DropUpload>;
  releaseUploadReservation(sessionId: string, id: string): Promise<void>;
  getDropUpload(sessionId: string, id: string): Promise<DropUpload | undefined>;
  completeDropUpload(sessionId: string, id: string, resourceId: string, completedAt: Date): Promise<DropUpload>;
  claimTelegramUpdate(updateId: string, telegramUserId: string | undefined, now: Date): Promise<"claimed" | "retry" | "duplicate" | "busy">;
  completeTelegramUpdate(updateId: string, now: Date): Promise<void>;
  failTelegramUpdate(updateId: string, failureCode: string, now: Date): Promise<void>;
}

export interface DropNotificationSink {
  securityAlert(): Promise<void>;
  uploadCompleted(identity: TelegramIdentity, filename: string, sizeBytes: number): Promise<void>;
}

export interface DropFileGateway {
  listChildren(parentId: string, offset?: number, limit?: number): Promise<readonly { readonly id: string; readonly type: "file" | "folder"; readonly name: string }[]>;
  createFolder(parentId: string, name: string, auditActor?: { readonly type: string; readonly id: string }): Promise<{ readonly id: string; readonly type: "file" | "folder"; readonly name: string }>;
  createUpload(input: {
    readonly parentId?: string;
    readonly filename: string;
    readonly expectedSize: number;
    readonly expectedSha256?: string;
    readonly idempotencyKey: string;
    readonly auditActor?: { readonly type: string; readonly id: string };
  }): Promise<{ readonly id: string }>;
  getUpload(id: string): Promise<{ readonly receivedSize: number; readonly expectedSize: number; readonly expiresAt: Date; readonly status: string }>;
  appendUpload(id: string, offset: number, contentLength: number, source: Readable): Promise<{ readonly receivedSize: number }>;
  completeUpload(id: string): Promise<{ readonly resource: { readonly id: string; readonly name: string; readonly sizeBytes: number; readonly sha256?: string }; readonly upload: { readonly receivedSize: number; readonly expectedSize: number; readonly expiresAt: Date; readonly status: string } }>;
}

export interface TelegramProvider {
  getMe(): Promise<{ readonly id: string; readonly isBot: boolean; readonly username?: string }>;
  setWebhook(input: { readonly url: string; readonly secretToken: string; readonly maxConnections: number }): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

export interface TelegramUpdate {
  readonly updateId: string;
  readonly message?: {
    readonly chatId: string;
    readonly chatType: string;
    readonly from?: { readonly userId: string; readonly isBot: boolean; readonly displayName?: string };
    readonly text?: string;
  };
}
