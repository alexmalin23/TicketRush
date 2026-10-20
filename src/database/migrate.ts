import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { loadDotEnvFile } from "../config/env";

/** <project>/migrations, both from src/database (ts-node) and dist/database (compiled). */
export const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

/** Any number; it just has to be the same for every process running migrations. */
const MIGRATION_LOCK_ID = 727274;

/**
 * Applies every migrations/*.sql file that has not run yet, in file-name order.
 * Each file runs in its own transaction and is recorded in schema_migrations.
 * An advisory lock stops two processes from migrating at the same time.
 */
export async function runMigrations(
  pool: Pool,
  dir = MIGRATIONS_DIR,
  log: (message: string) => void = () => undefined
): Promise<string[]> {
  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const alreadyApplied = new Set(rows.map((row) => row.name));
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;

      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
      appliedNow.push(file);
      log(`Applied ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }

  return appliedNow;
}

// `npm run db:migrate` runs this file directly.
if (require.main === module) {
  loadDotEnvFile();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  runMigrations(pool, MIGRATIONS_DIR, console.log)
    .then((applied) => console.log(applied.length ? "Migrations done" : "Nothing to migrate"))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
