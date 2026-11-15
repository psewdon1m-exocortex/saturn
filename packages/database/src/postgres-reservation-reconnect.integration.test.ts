import { requireTestValue } from "../../contracts/src/test-support.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { Database } from "./index.js";

const url = process.env.PIPELINE_TEST_DATABASE_URL;

// Real connection idle timers and a delayed event loop are essential here.
// Fake timers do not reproduce a socket closing while another pool reserves.
it.skipIf(!url)("resumes every admitted job after process pause and releases all connections on close", async () => {
  const db = new Database(requireTestValue(url), { max: 5, maintenanceBarrier: true });
  const prefix = `postgres-reservation-${randomUUID()}`;
  const pending = new Set<Promise<void>>();
  const active = new Set<number>();
  const counts = [0, 0, 0, 0];
  const errors: unknown[] = [];
  const round = () => {
    counts.forEach((_count, index) => {
      if (active.has(index)) return;
      active.add(index);
      const work = db.withAdvisoryLock(`${prefix}-${String(index)}`, () => db.withSharedMaintenance(async () => {
        await db.ping(); counts[index] = requireTestValue(counts[index]) + 1;
      }), 1000).catch((error: unknown) => { errors.push(error); }).finally(() => {
        active.delete(index); pending.delete(work);
      });
      pending.add(work);
    });
  };
  const interval = setInterval(round, 2000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await delay(7500);
    expect(counts.every(count => count >= 3)).toBe(true);
    const before = [...counts];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 21_000);
    await delay(7000);
    expect(counts.every((count, index) => count > requireTestValue(before[index]))).toBe(true);
    expect(errors).toEqual([]);
    clearInterval(interval);
    await Promise.race([
      Promise.all([...pending]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("admitted_jobs_failed_to_drain")), 2000);
      }),
    ]);
    expect(active.size).toBe(0);
  } finally {
    clearInterval(interval);
    if (timeout !== undefined) clearTimeout(timeout);
    await db.close();
  }
}, 45_000);
