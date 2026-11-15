import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { FileService } from "@saturn/file-core";
import type { StorageAdapter } from "@saturn/storage";
import { DATABASE, FILE_SERVICE, STORAGE_ADAPTER, GUARDED_RUNTIME } from "./tokens.js";
import type { GuardedRuntime } from "../../../packages/sync/src/guarded-runtime.js";

interface CloseableDatabase {
  close(): Promise<void>;
  reconcileInactiveFileLocks(): Promise<void>;
}

@Injectable()
export class RuntimeLifecycleService implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: CloseableDatabase,
    @Inject(FILE_SERVICE) private readonly files: FileService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Inject(GUARDED_RUNTIME) private readonly guarded?: GuardedRuntime,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.database.reconcileInactiveFileLocks();
    await this.files.initializeStorage();
  }

  async onApplicationShutdown(): Promise<void> {
    if(this.guarded)await this.guarded.close();else await this.storage.close();
    await this.database.close();
  }
}
