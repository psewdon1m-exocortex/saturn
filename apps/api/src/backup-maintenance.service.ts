import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { BackupIngestService } from "@saturn/backup-ingest";
import { BACKUP_INGEST_SERVICE } from "./tokens.js";

@Injectable()
export class BackupMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #logger = new Logger(BackupMaintenanceService.name);
  #timer?: NodeJS.Timeout;
  #running = false;

  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService) {}

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
      const result = await this.backups.reconcileCatalog();
      if (result.failed > 0) this.#logger.warn(`Backup catalog reconciliation published ${String(result.published)}/${String(result.scanned)}; ${String(result.failed)} failed`);
      else if (result.published > 0) this.#logger.log(`Backup catalog reconciliation verified ${String(result.published)} completed archives`);
      const retention = await this.backups.applyRetention();
      if (retention.failed > 0) this.#logger.warn(`Backup retention purged ${String(retention.purged)}/${String(retention.candidates)}; ${String(retention.failed)} failed`);
      else if (retention.purged > 0) this.#logger.log(`Backup retention purged ${String(retention.purged)} expired archives`);
    } catch (error) {
      this.#logger.error("Backup catalog reconciliation failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.#running = false;
    }
  }
}
