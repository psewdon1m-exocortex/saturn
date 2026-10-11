import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { BackupIngestService } from "@saturn/backup-ingest";
import type { Database } from "@saturn/database";
import { BACKUP_INGEST_SERVICE, DATABASE } from "./tokens.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";

@Injectable()
export class BackupMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #logger = new Logger(BackupMaintenanceService.name);
  #timer?: NodeJS.Timeout;
  #running = false;

  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TransferMonitorService) private readonly transfers: TransferMonitorService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
    this.#timer = setInterval(() => void this.reconcile(), 15 * 60_000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  private async reconcile(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.database.withSharedMaintenance(async () => {
        const incomplete = await this.backups.expireIncompleteRuns(new Date(), runId => this.transfers.controlState(`backup:${runId}`) === "paused");
        if (incomplete.failed > 0) this.#logger.warn(`Backup incomplete cleanup expired ${String(incomplete.expired)}, recovered ${String(incomplete.recovered)}; ${String(incomplete.failed)} failed`);
        else if (incomplete.expired > 0 || incomplete.recovered > 0) this.#logger.log(`Backup incomplete cleanup expired ${String(incomplete.expired)}, recovered ${String(incomplete.recovered)}`);
        const result = await this.backups.reconcileCatalog();
        if (result.failed > 0) this.#logger.warn(`Backup catalog reconciliation published ${String(result.published)}/${String(result.scanned)}; ${String(result.failed)} failed`);
        else if (result.published > 0) this.#logger.log(`Backup catalog reconciliation verified ${String(result.published)} completed archives`);
        const retention = await this.backups.applyRetention();
        if (retention.failed > 0) this.#logger.warn(`Backup retention purged ${String(retention.purged)}/${String(retention.candidates)}; ${String(retention.failed)} failed`);
        else if (retention.purged > 0) this.#logger.log(`Backup retention purged ${String(retention.purged)} expired archives`);
      });
    } catch (error) {
      this.#logger.error("Backup catalog reconciliation failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.#running = false;
    }
  }
}
