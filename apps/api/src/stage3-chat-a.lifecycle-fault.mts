// Explicit preload for a disposable CLI child. The production CLI has no fault flags.
import { Database } from "@saturn/database";
const fault = process.env.STAGE3_CHAT_A_FAULT;
if (!["before-progress", "after-progress", "after-receipt"].includes(fault ?? "") || !process.argv.some(p => p.includes("stage3_"))) throw Error("owned lifecycle fault fixture required");
const transaction = Object.getOwnPropertyDescriptor(Database.prototype, "transaction")?.value as Database["transaction"];
Database.prototype.transaction = async function <T>(action: Parameters<Database["transaction"]>[0]): Promise<T> {
  let progress = false, receipt = false;
  const effects = () => ({progress,receipt});
  const result = await transaction.call(this, async sql => {
    const intercepted = new Proxy(sql, { apply(target, receiver:unknown, args:unknown[]) {
      const text = Array.isArray(args[0]) ? (args[0] as unknown[]).map(String).join("?") : "";
      if (text.includes("INSERT INTO sync_migration_progress")) progress = true;
      if (text.includes("UPDATE sync_migration_plans SET state='APPLIED'")) receipt = true;
      return Reflect.apply(target, receiver, args) as unknown;
    } });
    const value = await action(intercepted);
    if (progress && fault === "before-progress") process.exit(86);
    return value;
  });
  if (effects().progress && fault === "after-progress" || effects().receipt && fault === "after-receipt") process.exit(86);
  return result as T;
};

