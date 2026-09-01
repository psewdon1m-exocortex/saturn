export interface RecoveryLimits {
  readonly maxArchiveBytes: number;
  readonly maxMemberBytes: number;
  readonly maxExtractedBytes: number;
  readonly maxEntries: number;
  readonly maxCompressionRatio: number;
  readonly maxManifestBytes: number;
}

export interface BackupMember {
  readonly path: string;
  readonly sourcePath: string;
  readonly mediaType: string;
}

export interface ManifestMember {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mediaType: string;
}

export interface BackupManifest {
  readonly schema: "vault.backup.v1";
  readonly backupId: string;
  readonly createdAt: string;
  readonly database: {
    readonly engine: "postgresql";
    readonly logicalFormat: "custom";
  };
  readonly members: readonly ManifestMember[];
}

export interface CreatedBackup {
  readonly archivePath: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly manifest: BackupManifest;
  readonly extractedBytes: number;
}

export interface ValidatedBackup {
  readonly archivePath: string;
  readonly extractionDirectory: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly extractedBytes: number;
  readonly manifest: BackupManifest;
}

export interface LogicalDatabaseToolchain {
  createDump(outputPath: string): Promise<void>;
  restoreDump(dumpPath: string, mode: "clean" | "replace"): Promise<void>;
  verifyRestoredDatabase(): Promise<Record<string, number>>;
}

export interface MetadataExporter {
  exportTo(directory: string): Promise<readonly BackupMember[]>;
}

export interface BackupRunInput {
  readonly outputPath: string;
  readonly publicConfiguration: Readonly<Record<string, unknown>>;
  readonly deploymentManifestPath: string;
  readonly migrationsDirectory: string;
  readonly encryptedRecoveryBundlePath?: string;
  readonly kind: "scheduled" | "manual" | "pre_restore" | "restore_drill";
}

export interface RestoreInput {
  readonly archivePath: string;
  readonly mode: "clean" | "replace";
  readonly snapshotOutputPath?: string;
  readonly snapshotInput?: Omit<BackupRunInput, "outputPath" | "kind">;
}

export interface RestoreResult {
  readonly backupId: string;
  readonly mode: "clean" | "replace";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly measuredRpoMs: number;
  readonly measuredRtoMs: number;
  readonly verification: Readonly<Record<string, number>>;
  readonly snapshotPath?: string;
}
