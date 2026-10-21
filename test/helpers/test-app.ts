import type { Pool } from "pg";
import request from "supertest";
import { appDefinition } from "../../src/app";
import type { Role } from "../../src/common/types/auth-user";
import { ExpressFactory, ModexApplication } from "../../src/core";
import { PG_POOL } from "../../src/database/database.constants";
import { DatabaseService } from "../../src/database/database.service";
import { runMigrations } from "../../src/database/migrate";

/** Boots the real application (real DI, real Postgres) without opening a port. */
export async function createTestApp(): Promise<ModexApplication> {
  const app = await ExpressFactory.create(appDefinition);
  app.init();
  await runMigrations(app.get<Pool>(PG_POOL));
  return app;
}

/** Empties every table and restarts ids at 1, so each test starts from a known state. */
export async function resetDatabase(app: ModexApplication): Promise<void> {
  await app
    .get(DatabaseService)
    .query("TRUNCATE idempotency_keys, tickets, payments, order_items, orders, seats, events, venues, users RESTART IDENTITY CASCADE");
}

export function http(app: ModexApplication) {
  return request(app.getExpressApp());
}

/** Registers a user through the API and returns a token. Admins are promoted with SQL. */
export async function createUser(
  app: ModexApplication,
  email: string,
  role: Role = "user",
  password = "password123"
): Promise<{ id: number; token: string }> {
  const registered = await http(app).post("/api/v1/auth/register").send({ email, password }).expect(201);
  const id: number = registered.body.id;

  if (role === "user") return { id, token: registered.body.accessToken };

  await app.get(DatabaseService).query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
  // Log in again: the role is inside the token.
  const login = await http(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
  return { id, token: login.body.accessToken };
}


export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
