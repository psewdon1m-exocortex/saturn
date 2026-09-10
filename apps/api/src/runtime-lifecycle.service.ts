import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { FileService } from "@saturn/file-core";
import type { StorageAdapter } from "@saturn/storage";
import { DATABASE, FILE_SERVICE, STORAGE_ADAPTER } from "./tokens.js";

interface CloseableDatabase {
  close(): Promise<void>;
}

@Injectable()
export class RuntimeLifecycleService implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: CloseableDatabase,
    @Inject(FILE_SERVICE) private readonly files: FileService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.files.initializeStorage();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.storage.close();
    await this.database.close();
  }
}
