import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import fs from "node:fs/promises";
import { AuditService } from "@saturn/audit";
import { ArchiveService, PostgresArchiveJobRepository, type ArchiveJobRepository } from "@saturn/archive";
import { OwnerAuthService, PostgresOwnerAuthRepository } from "@saturn/auth";
import { BackupIngestService, PostgresBackupRepository, type BackupRepository } from "@saturn/backup-ingest";
import { loadEnvironment } from "@saturn/config";
import { Database } from "@saturn/database";
import { DropBufferStore, DropService, GryphonNotificationSink, PostgresDropRepository, type DropRepository } from "@saturn/drop";
import { BACKUPS_RESOURCE_ID, FileService, PostgresFileRepository } from "@saturn/file-core";
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
import { GryphonController } from "./gryphon.controller.js";
import { GryphonOwnerController } from "./gryphon-owner.controller.js";
import { GryphonEventStore } from "./gryphon-event.store.js";
import { PublicShareController, ResourceClassificationController, ShareOwnerController } from "./share.controller.js";
import { ShareApiExceptionFilter } from "./share-api-exception.filter.js";
import { DeviceController } from "./device.controller.js";
import { BackupCapabilitiesController, BackupEnrollmentController, BackupOwnerController, BackupProducerController, BackupRestoreController } from "./backup.controller.js";
import { BackupApiExceptionFilter } from "./backup-api-exception.filter.js";
import { LaboratoryAssetController, LaboratoryClientController, LaboratoryDeliveryController, LaboratoryImportController } from "./laboratory.controller.js";
import { LaboratoryApiExceptionFilter } from "./laboratory-api-exception.filter.js";
import { createAuditService } from "./audit.factory.js";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import {
  APP_CONFIG,
  ARCHIVE_REPOSITORY,
  ARCHIVE_SERVICE,
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
  GRYPHON_EVENT_STORE,
  LABORATORY_REPOSITORY,
  LABORATORY_SERVICE,
  PURGE_SERVICE,
  RECONCILIATION_SERVICE,
  SHARE_REPOSITORY,
  SHARE_SERVICE,
  STORAGE_ADAPTER,
  STORAGE_HEALTH,
  STORAGE_RUNTIME,
} from "./tokens.js";
import { ArchiveController } from "./archive.controller.js";
import { OperatorController } from "./operator.controller.js";
import { UpdaterController } from "./updater.controller.js";
import { HelperRecoveryController } from "./helper-recovery.controller.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";
import { TransferTaskController } from "./transfer-task.controller.js";
import { MaintenanceBarrierInterceptor } from "./maintenance-barrier.interceptor.js";
import { RecoveryController } from "./recovery.controller.js";
import { NeptuneExportController, NeptuneOwnerController } from "./neptune.controller.js";
import { RecoveryWorkflowService } from "./recovery-workflow.service.js";
import { StorageConnectionController } from "./storage-connection.controller.js";
import { StorageConnectionService } from "./storage-connection.service.js";
import { SyncClientController } from "./sync-client.controller.js";
import { NeptuneAgentController, NeptuneFleetOwnerController } from "./neptune-fleet.controller.js";
import { NeptuneFleetService } from "./neptune-fleet.service.js";

const config = loadEnvironment();

@Module({
  controllers: [HelperRecoveryController, UpdaterController, HealthController, AuthController, OperatorController, TransferTaskController, ArchiveController, StorageConnectionController, RecoveryController, NeptuneExportController, NeptuneOwnerController, NeptuneAgentController, NeptuneFleetOwnerController, GryphonOwnerController, FileController, ActivityController, ProtectionController, DropController, GryphonController, ShareOwnerController, ResourceClassificationController, PublicShareController, DeviceController, SyncClientController, BackupOwnerController, BackupRestoreController, BackupEnrollmentController, BackupCapabilitiesController, BackupProducerController, LaboratoryClientController, LaboratoryAssetController, LaboratoryImportController, LaboratoryDeliveryController],
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
    { provide: ARCHIVE_REPOSITORY, useFactory: (database: Database) => new PostgresArchiveJobRepository(database), inject: [DATABASE] },
    {
      provide: ARCHIVE_SERVICE,
      useFactory: (repository: ArchiveJobRepository, files: FileService, audit: AuditService) => new ArchiveService(repository, files, audit),
      inject: [ARCHIVE_REPOSITORY, FILE_SERVICE, AUDIT_SERVICE],
    },
    { provide: DROP_REPOSITORY, useFactory: (database: Database) => new PostgresDropRepository(database), inject: [DATABASE] },
    { provide: GRYPHON_EVENT_STORE, useFactory: (database: Database) => new GryphonEventStore(database), inject: [DATABASE] },
    {
      provide: DROP_SERVICE,
      useFactory: async (repository: DropRepository, files: FileService, audit: AuditService) => {
        const drop = new DropService({
          repository,
          files,
          pepper: (await fs.readFile(config.drop.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
          options: {
          publicOrigin: config.publicOrigin,
          codeTtlMs: config.drop.codeTtlMs,
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
          maxBytes: async () => (await files.getUploadLimits()).bufferMaxBytes,
          minFreeBytes: config.drop.bufferMinFreeBytes,
          warningRatio: config.drop.bufferWarningRatio,
          criticalRatio: config.drop.bufferCriticalRatio,
          refusalRatio: config.drop.bufferRefusalRatio,
          }),
          audit,
        });
        if (config.gryphon.enabled && config.gryphon.serviceTokenFile !== undefined) {
          const token = (await fs.readFile(config.gryphon.serviceTokenFile, "utf8")).replace(/[\r\n]+$/, "");
          drop.setNotificationSink(new GryphonNotificationSink(config.gryphon.socketPath, token, config.gryphon.timeoutMs));
        }
        return drop;
      },
      inject: [DROP_REPOSITORY, FILE_SERVICE, AUDIT_SERVICE],
    },
    { provide: SHARE_REPOSITORY, useFactory: (database: Database) => new PostgresShareRepository(database), inject: [DATABASE] },
    { provide: DEVICE_REPOSITORY, useFactory: (database: Database) => new PostgresDeviceRepository(database), inject: [DATABASE] },
    { provide: BACKUP_INGEST_REPOSITORY, useFactory: (database: Database) => new PostgresBackupRepository(database), inject: [DATABASE] },
    { provide: LABORATORY_REPOSITORY, useFactory: (database: Database) => new PostgresLaboratoryRepository(database), inject: [DATABASE] },
    {
      provide: LABORATORY_SERVICE,
      useFactory: async (repository: LaboratoryRepository, files: FileService, audit: AuditService, database: Database) => new LaboratoryService({
        repository,
        files,
        pepper: (await fs.readFile(config.laboratory.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
        options: {
          enabled: config.laboratory.enabled,
          publicEnabled: config.laboratory.publicEnabled,
          publicOrigin: config.publicOrigin,
          resolvePublicOrigin: registeredOrigin(database, config, "saturn"),
          tokenRotationGraceMs: config.laboratory.tokenRotationGraceMs,
          maxConcurrentPublicStreams: config.laboratory.maxConcurrentPublicStreams,
        },
        audit,
      }),
      inject: [LABORATORY_REPOSITORY, FILE_SERVICE, AUDIT_SERVICE, DATABASE],
    },
    {
      provide: BACKUP_INGEST_SERVICE,
      useFactory: async (repository: BackupRepository, storage: StorageAdapter, audit: AuditService, files: FileService) => new BackupIngestService({
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
        backupRootPath: async () => (await files.getResource(BACKUPS_RESOURCE_ID)).storagePath,
        audit,
      }),
      inject: [BACKUP_INGEST_REPOSITORY, STORAGE_ADAPTER, AUDIT_SERVICE, FILE_SERVICE],
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
      useFactory: async (repository: ShareRepository, files: FileService, storage: StorageAdapter, audit: AuditService, database: Database) => new ShareService({
        repository,
        files,
        storage,
        pepper: (await fs.readFile(config.share.pepperFile, "utf8")).replace(/[\r\n]+$/, ""),
        options: {
          enabled: config.share.enabled,
          publicOrigin: config.publicOrigin,
          resolvePublicOrigin: registeredOrigin(database, config, "saturn"),
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
      inject: [SHARE_REPOSITORY, FILE_SERVICE, STORAGE_ADAPTER, AUDIT_SERVICE, DATABASE],
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
    NeptuneFleetService,
    { provide: APP_INTERCEPTOR, useClass: MaintenanceBarrierInterceptor },
    RuntimeLifecycleService,
  ],
})
// Nest modules are declarative metadata containers by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
import { registeredOrigin } from "./kernel-discovery.js";
