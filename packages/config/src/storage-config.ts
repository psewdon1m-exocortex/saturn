export interface StorageTimeouts {
  readonly operationTimeoutMs: number;
  readonly healthTimeoutMs: number;
  readonly maxConnections: number;
  readonly requireFsync?: boolean;
}

/** Omission preserves the exact pre-local SFTP configuration/fence digest. */
export interface SftpStorageConfig extends StorageTimeouts {
  readonly backend?: "sftp";
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly root: string;
  readonly hostFingerprint: string;
  readonly authMode: "password_file" | "private_key_file";
  readonly passwordFile?: string;
  readonly privateKeyFile?: string;
}

export interface LocalStorageConfig extends StorageTimeouts {
  readonly backend: "local";
  readonly root: string;
  readonly custodyFile: string;
  readonly requireFsync: true;
  // Absent legacy fields let redaction/status readers inspect optional material;
  // an SFTP consumer still has to narrow before using any connection setting.
  readonly host?: never;
  readonly port?: never;
  readonly username?: never;
  readonly hostFingerprint?: never;
  readonly authMode?: never;
  readonly passwordFile?: never;
  readonly privateKeyFile?: never;
}

export type StorageConfig = SftpStorageConfig | LocalStorageConfig;

export function requireSftpStorage(config: StorageConfig): SftpStorageConfig {
  if (config.backend === "local") throw new Error("SFTP profile operations are unavailable for an operator-pinned local backend");
  return config;
}
