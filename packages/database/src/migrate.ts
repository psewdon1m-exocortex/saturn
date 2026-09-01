import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDirectory = path.resolve(moduleDirectory, "../migrations");

async function ensureMigrationTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _vault_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function listMigrationPairs(
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<readonly { readonly name: string; readonly up: string; readonly down: string }[]> {
  const files = await fs.readdir(migrationsDirectory);
  const names = files
    .filter((name) => /^\d+_[a-z0-9_-]+\.up\.sql$/i.test(name))
    .map((name) => name.replace(/\.up\.sql$/i, ""))
    .sort();
  const pairs = [];
  for (const name of names) {
    const up = path.join(migrationsDirectory, `${name}.up.sql`);
    const down = path.join(migrationsDirectory, `${name}.down.sql`);
    await fs.access(down);
    pairs.push({ name, up, down });
  }
  return pairs;
}

export async function migrate(databaseUrl: string, migrationsDirectory = defaultMigrationsDirectory): Promise<number> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await ensureMigrationTable(sql);
    const appliedRows = await sql<{ name: string }[]>`SELECT name FROM _vault_migrations`;
    const applied = new Set(appliedRows.map((row) => row.name));
    let count = 0;
    for (const migration of await listMigrationPairs(migrationsDirectory)) {
      if (applied.has(migration.name)) continue;
      const source = await fs.readFile(migration.up, "utf8");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(source);
        await transaction`INSERT INTO _vault_migrations (name) VALUES (${migration.name})`;
      });
      count += 1;
    }
    return count;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function rollback(databaseUrl: string, migrationsDirectory = defaultMigrationsDirectory): Promise<string | undefined> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await ensureMigrationTable(sql);
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM _vault_migrations ORDER BY applied_at DESC, name DESC LIMIT 1
    `;
    const name = rows[0]?.name;
    if (name === undefined) return undefined;
    const downPath = path.join(migrationsDirectory, `${name}.down.sql`);
    const source = await fs.readFile(downPath, "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`DELETE FROM _vault_migrations WHERE name = ${name}`;
    });
    return name;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runCli(): Promise<void> {
  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databasePasswordFile = process.env.DATABASE_PASSWORD_FILE;
  if (databasePasswordFile) {
    const password = (await fs.readFile(databasePasswordFile, "utf8")).replace(/[\r\n]+$/, "");
    if (password.length < 16 || /[\r\n]/.test(password)) throw new Error("DATABASE_PASSWORD_FILE is invalid");
    const parsed = new URL(databaseUrl);
    if (parsed.password) throw new Error("DATABASE_URL must not contain a password when DATABASE_PASSWORD_FILE is set");
    parsed.password = password;
    databaseUrl = parsed.toString();
  }
  const direction = process.argv[2];
  if (direction === "up") {
    const count = await migrate(databaseUrl);
    process.stdout.write(`${JSON.stringify({ direction, applied: count })}\n`);
    return;
  }
  if (direction === "down") {
    const name = await rollback(databaseUrl);
    process.stdout.write(`${JSON.stringify({ direction, rolledBack: name ?? null })}\n`);
    return;
  }
  throw new Error("Migration direction must be 'up' or 'down'");
}

const isCli = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) await runCli();
