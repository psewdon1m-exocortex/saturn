import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import fs from "node:fs/promises";
import { AuditService } from "@saturn/audit";
import { OwnerAuthService, PostgresOwnerAuthRepository } from "@saturn/auth";
import { BackupIngestService, PostgresBackupRepository, type BackupRepository } from "@saturn/backup-ingest";
import { loadEnvironment } from "@saturn/config";
import { Database } from "@saturn/database";
import { DropBufferStore, DropService, PostgresDropRepository, TelegramHttpProvider, TelegramNotifier, TelegramSupervisor, TelegramWebhookService, type DropRepository, type TelegramProvider } from "@saturn/drop";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import { LaboratoryService, PostgresLaboratoryRepository, type LaboratoryRepository } from "@saturn/laboratory";
import { RuntimeStorageManager, type StorageAdapter } from "@saturn/storage";
import { PostgresPurgeRepository, PostgresReconciliationRepository, PurgeService, ReconciliationService } from "@saturn/protection";
import { AdapterStorageHealthProbe } from "@saturn/storage-health";
import { PostgresShareRepository, ShareService, type ShareRepository } from "@saturn/shares";
import { DeviceService, PostgresDeviceRepository, type DeviceRepository } from "@saturn/sync";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import { RuntimeLifecycleService } from "./runtime-lifecycle.service.js";
import { FileController } from "./file.controller.js";
import { ActivityController } from "./activity.controller.js";
import { ProtectionController } from "./protection.controller.js";
import { AuthController } from "./auth.controller.js";
import { DropController } from "./drop.controller.js";
import { DropSessionGuard } from "./drop-session.guard.js";
import { TelegramOwnerController, TelegramWebhookController } from "./telegram.controller.js";
import { PublicShareController, ResourceClassificationController, ShareOwnerController } from "./share.controller.js";
import { ShareApiExceptionFilter } from "./share-api-exception.filter.js";
import { DeviceController } from "./device.controller.js";
import { BackupOwnerController, BackupProducerController, BackupRestoreController } from "./backup.controller.js";
import { BackupApiExceptionFilter } from "./backup-api-exception.filter.js";
import { LaboratoryAssetController, LaboratoryClientController, LaboratoryDeliveryController } from "./laboratory.controller.js";
import { LaboratoryApiExceptionFilter } from "./laboratory-api-exception.filter.js";
import { createAuditService } from "./audit.factory.js";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import {
  APP_CONFIG,
  AUDIT_SERVICE,
  AUTH_SERVICE,
  BACKUP_INGEST_REPOSITORY,
  BACKUP_INGEST_SERVICE,
  DATABASE,
  DEVICE_REPOSITORY,
  DEVICE_SERVICE,
  DROP_REPOSITORY,
  DROP_SERVICE,
  FILE_SERVICE,
  LABORATORY_REPOSITORY,
  LABORATORY_SERVICE,
  PURGE_SERVICE,
  RECONCILIATION_SERVICE,
  SHARE_REPOSITORY,
  SHARE_SERVICE,
  STORAGE_ADAPTER,
  STORAGE_HEALTH,
  STORAGE_RUNTIME,
  TELEGRAM_PROVIDER,
  TELEGRAM_RUNTIME,
  TELEGRAM_SUPERVISOR,
  TELEGRAM_WEBHOOK_SERVICE,
} from "./tokens.js";
import { OperatorController } from "./operator.controller.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";
import { MaintenanceBarrierInterceptor } from "./maintenance-barrier.interceptor.js";
import { RecoveryController } from "./recovery.controller.js";
import { RecoveryWorkflowService } from "./recovery-workflow.service.js";
import { StorageConnectionController } from "./storage-connection.controller.js";
import { StorageConnectionService } from "./storage-connection.service.js";

const config = loadEnvironment();

@Module({
  controllers: [HealthController, AuthController, OperatorController, StorageConnectionController, RecoveryController, FileController, ActivityController, ProtectionController, DropController, TelegramOwnerController, TelegramWebhookController, ShareOwnerController, ResourceClassificationController, PublicShareController, DeviceController, BackupOwnerController, BackupRestoreController, BackupProducerController, LaboratoryClientController, LaboratoryAssetController, LaboratoryDeliveryController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: DATABASE, useFactory: () => new Database(config.databaseUrl, { max: 10, maintenanceBarrier: true }) },
    {
      provide: STORAGE_RUNTIME,
      useFactory: async () => {
        const storage = new RuntimeStorageManager(config.storage, config.storageRuntimeConfigDirectory);
        await storage.initialize();
        return storage;
      },
    },
    { provide: STORAGE_ADAPTER, useExisting: STORAGE_RUNTIME },
    {
      provide: AUDIT_SERVICE,
      useFactory: (database: Database) => createAuditService(database, config),
      inject: [DATABASE],
    },
    {
      provide: AUTH_SERVICE,
      useFactory: async (database: Database, audit: AuditService) => {
        const service = new OwnerAuthService({
          repository: new PostgresOwnerAuthRepository(database),
          ownerAccessKey: (await fs.readFile(config.ownerBootstrapTokenFile, "utf8")).replace(/[\r\n]+$/, ""),
          pepper: (await fs.readFile(config.auth.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
          options: {
            publicOrigin: config.publicOrigin,
            sessionIdleTtlMs: config.auth.sessionIdleTtlMs,
            sessionAbsoluteTtlMs: config.auth.sessionAbsoluteTtlMs,
            reauthTtlMs: config.auth.reauthTtlMs,
            failureLimit: config.auth.failureLimit,
            failureWindowMs: config.auth.failureWindowMs,
          },
          audit,
        });
        await service.initialize();
        return service;
      },
      inject: [DATABASE, AUDIT_SERVICE],
    },
    {
      provide: FILE_SERVICE,
      useFactory: (database: Database, storage: StorageAdapter, audit: AuditService) => new FileService(
        new PostgresFileRepository(database),
        storage,
        { ...config.limits, auditSink: audit },
      ),
      inject: [DATABASE, STORAGE_ADAPTER, AUDIT_SERVICE],
    },
    { provide: DROP_REPOSITORY, useFactory: (database: Database) => new PostgresDropRepository(database), inject: [DATABASE] },
    {
      provide: TELEGRAM_RUNTIME,
      useFactory: async () => {
        const token = config.telegram.botTokenFile === undefined
          ? "100000:disabled_vault_telegram_token_000000"
          : (await fs.readFile(config.telegram.botTokenFile, "utf8")).replace(/[\r\n]+$/, "");
        const webhookSecret = config.telegram.webhookSecretFile === undefined
          ? "disabled_vault_webhook_secret"
          : (await fs.readFile(config.telegram.webhookSecretFile, "utf8")).replace(/[\r\n]+$/, "");
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) throw new Error("Telegram webhook secret is invalid");
        return { token, webhookSecret };
      },
    },
    {
      provide: TELEGRAM_PROVIDER,
      useFactory: (runtime: { readonly token: string }) => new TelegramHttpProvider({
        token: runtime.token,
        baseUrl: config.telegram.apiBaseUrl,
        timeoutMs: config.telegram.providerTimeoutMs,
      }),
      inject: [TELEGRAM_RUNTIME],
    },
    {
      provide: DROP_SERVICE,
      useFactory: async (repository: DropRepository, files: FileService, audit: AuditService) => new DropService({
        repository,
        files,
        pepper: (await fs.readFile(config.drop.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
        options: {
          publicOrigin: config.publicOrigin,
          codeTtlMs: config.drop.codeTtlMs,
          linkCodeTtlMs: config.drop.linkCodeTtlMs,
          sessionTtlMs: config.drop.sessionTtlMs,
          maxFiles: config.drop.maxFiles,
          maxBytes: config.drop.maxBytes,
          failureLimit: config.drop.failureLimit,
          globalFailureLimit: config.drop.globalFailureLimit,
          failureWindowMs: config.drop.failureWindowMs,
          continuationTtlMs: config.drop.continuationTtlMs,
        },
        buffer: new DropBufferStore({
          root: config.drop.bufferDirectory,
          maxBytes: config.drop.bufferMaxBytes,
          minFreeBytes: config.drop.bufferMinFreeBytes,
          warningRatio: config.drop.bufferWarningRatio,
          criticalRatio: config.drop.bufferCriticalRatio,
          refusalRatio: config.drop.bufferRefusalRatio,
        }),
        audit,
      }),
      inject: [DROP_REPOSITORY, FILE_SERVICE, AUDIT_SERVICE],
    },
    { provide: SHARE_REPOSITORY, useFactory: (database: Database) => new PostgresShareRepository(database), inject: [DATABASE] },
    { provide: DEVICE_REPOSITORY, useFactory: (database: Database) => new PostgresDeviceRepository(database), inject: [DATABASE] },
    { provide: BACKUP_INGEST_REPOSITORY, useFactory: (database: Database) => new PostgresBackupRepository(database), inject: [DATABASE] },
    { provide: LABORATORY_REPOSITORY, useFactory: (database: Database) => new PostgresLaboratoryRepository(database), inject: [DATABASE] },
    {
      provide: LABORATORY_SERVICE,
      useFactory: async (repository: LaboratoryRepository, files: FileService, audit: AuditService) => new LaboratoryService({
        repository,
        files,
        pepper: (await fs.readFile(config.laboratory.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
        options: {
          enabled: config.laboratory.enabled,
          publicEnabled: config.laboratory.publicEnabled,
          publicOrigin: config.publicOrigin,
          tokenRotationGraceMs: config.laboratory.tokenRotationGraceMs,
          maxConcurrentPublicStreams: config.laboratory.maxConcurrentPublicStreams,
        },
        audit,
      }),
      inject: [LABORATORY_REPOSITORY, FILE_SERVICE, AUDIT_SERVICE],
    },
    {
      provide: BACKUP_INGEST_SERVICE,
      useFactory: async (repository: BackupRepository, storage: StorageAdapter, audit: AuditService) => new BackupIngestService({
        repository,
        storage,
        pepper: (await fs.readFile(config.backupIngest.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
        options: {
          enabled: config.backupIngest.enabled,
          trustClientCertificateHeader: config.backupIngest.trustClientCertificateHeader,
          tokenRotationGraceMs: config.backupIngest.tokenRotationGraceMs,
          uploadChunkMaxBytes: config.limits.uploadChunkMaxBytes,
          incompleteTtlMs: config.limits.uploadIncompleteTtlMs,
          defaults: {
            requireEncryption: config.backupIngest.requireEncryption,
            maxBackupBytes: config.backupIngest.maxRunBytes,
            dailyQuotaBytes: config.backupIngest.dailyQuotaBytes,
            storedQuotaBytes: config.backupIngest.storedQuotaBytes,
            maxConcurrentRuns: config.backupIngest.maxConcurrentRuns,
            freshnessSlaMs: config.backupIngest.freshnessSlaMs,
            retention: config.backupIngest.retention,
          },
        },
        audit,
      }),
      inject: [BACKUP_INGEST_REPOSITORY, STORAGE_ADAPTER, AUDIT_SERVICE],
    },
    {
      provide: DEVICE_SERVICE,
      useFactory: async (repository: DeviceRepository, files: FileService, audit: AuditService) => new DeviceService({
        repository,
        files,
        pepper: (await fs.readFile(config.device.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
        options: {
          enabled: config.device.enabled,
          publicOrigin: config.publicOrigin,
          uploadChunkMaxBytes: config.limits.uploadChunkMaxBytes,
          propfindMaxItems: config.device.propfindMaxItems,
          deleteMaxItems: config.device.deleteMaxItems,
          deleteWindowMs: config.device.deleteWindowMs,
        },
        audit,
      }),
      inject: [DEVICE_REPOSITORY, FILE_SERVICE, AUDIT_SERVICE],
    },
    {
      provide: SHARE_SERVICE,
      useFactory: async (repository: ShareRepository, files: FileService, storage: StorageAdapter, audit: AuditService) => new ShareService({
        repository,
        files,
        storage,
        pepper: (await fs.readFile(config.share.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
        options: {
          enabled: config.share.enabled,
          publicOrigin: config.publicOrigin,
          defaultExpiryMs: config.share.defaultExpiryMs,
          maxExpiryMs: config.share.maxExpiryMs,
          sessionTtlMs: config.share.sessionTtlMs,
          passwordFailureLimit: config.share.passwordFailureLimit,
          passwordFailureWindowMs: config.share.passwordFailureWindowMs,
          packageMaxFiles: config.share.packageMaxFiles,
          packageMaxBytes: config.share.packageMaxBytes,
          packageMaxDurationMs: config.share.packageMaxDurationMs,
          streamRevalidateBytes: config.share.streamRevalidateBytes,
        },
        audit,
      }),
      inject: [SHARE_REPOSITORY, FILE_SERVICE, STORAGE_ADAPTER, AUDIT_SERVICE],
    },
    {
      provide: TELEGRAM_SUPERVISOR,
      useFactory: (provider: TelegramProvider, runtime: { readonly webhookSecret: string }) => new TelegramSupervisor({
        enabled: config.telegram.enabled,
        provider,
        publicOrigin: config.publicOrigin,
        webhookSecret: runtime.webhookSecret,
        maxConnections: config.telegram.webhookMaxConnections,
      }),
      inject: [TELEGRAM_PROVIDER, TELEGRAM_RUNTIME],
    },
    {
      provide: TELEGRAM_WEBHOOK_SERVICE,
      useFactory: (drop: DropService, repository: DropRepository, provider: TelegramProvider, supervisor: TelegramSupervisor, runtime: { readonly webhookSecret: string }) => {
        drop.setNotificationSink(new TelegramNotifier(drop, provider, supervisor));
        return new TelegramWebhookService({ drop, repository, provider, supervisor, webhookSecret: runtime.webhookSecret });
      },
      inject: [DROP_SERVICE, DROP_REPOSITORY, TELEGRAM_PROVIDER, TELEGRAM_SUPERVISOR, TELEGRAM_RUNTIME],
    },
    {
      provide: RECONCILIATION_SERVICE,
      useFactory: (database: Database, storage: StorageAdapter, audit: AuditService) => new ReconciliationService(
        new PostgresReconciliationRepository(database),
        storage,
        audit,
      ),
      inject: [DATABASE, STORAGE_ADAPTER, AUDIT_SERVICE],
    },
    {
      provide: PURGE_SERVICE,
      useFactory: (database: Database, storage: StorageAdapter, audit: AuditService) => new PurgeService(
        new PostgresPurgeRepository(database),
        storage,
        config.protection.purgeEnabled,
        audit,
      ),
      inject: [DATABASE, STORAGE_ADAPTER, AUDIT_SERVICE],
    },
    { provide: STORAGE_HEALTH, useFactory: (storage: StorageAdapter) => new AdapterStorageHealthProbe(storage), inject: [STORAGE_ADAPTER] },
    HealthService,
    OwnerTokenGuard,
    DropSessionGuard,
    SaturnApiExceptionFilter,
    ShareApiExceptionFilter,
    BackupApiExceptionFilter,
    LaboratoryApiExceptionFilter,
    TransferMonitorService,
    {
      provide: StorageConnectionService,
      useFactory: (database: Database, storage: RuntimeStorageManager, audit: AuditService) => new StorageConnectionService(database, storage, config, audit),
      inject: [DATABASE, STORAGE_RUNTIME, AUDIT_SERVICE],
    },
    RecoveryWorkflowService,
    { provide: APP_INTERCEPTOR, useClass: MaintenanceBarrierInterceptor },
    RuntimeLifecycleService,
  ],
})
// Nest modules are declarative metadata containers by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
