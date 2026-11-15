import type { PostgresSyncSnapshotReader } from './sync-snapshot-read.js';
import type { PostgresSyncSnapshotStage } from './sync-snapshot-stage.js';

/** One bounded maintenance step. Cursor foreign keys must drain before stage
 * documents/headers. Both collectors recheck expiry under their existing locks;
 * no lease or namespace state is changed to make a snapshot collectible. */
export async function collectExpiredSyncSnapshots(scope: {
  reader: Pick<PostgresSyncSnapshotReader,'collectExpired'>;
  stage: Pick<PostgresSyncSnapshotStage,'collectExpired'>;
}): Promise<void> {
  const cursors = await scope.reader.collectExpired();
  if (cursors.snapshotId !== null) return;
  await scope.stage.collectExpired();
}
