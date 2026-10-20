import { Pool } from "pg";
import { loadDotEnvFile } from "../config/env";
import { hashPassword } from "../modules/auth/password";

/**
 * Development data: one admin and a few products. Safe to run more than once.
 * Admin login: admin@example.com / admin12345
 */
async function seed(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    ["admin@example.com", await hashPassword("admin12345")]
  );

  const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM products");
  if (Number(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO products (name, price, stock) VALUES
         ('Keyboard', 120, 25), ('Mouse', 60, 40), ('27" Monitor', 900, 8), ('Headphones', 250, 15)`
    );
  }
}

loadDotEnvFile();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
seed(pool)
  .then(() => console.log("Seed done. Admin: admin@example.com / admin12345"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
