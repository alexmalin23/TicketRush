import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { Inject, Injectable, Logger, OnInit, OnShutdown } from "../core";
import { PG_POOL, PG_REPLICA_POOL, Queryable } from "./database.constants";

/**
 * The one entry point to PostgreSQL.
 * - query(): runs on any free connection from the shared pool
 * - transaction(): runs several queries on ONE connection, all-or-nothing
 * - reader: where reads that tolerate replication lag go
 * - onInit(): checks the connection at startup (fail fast)
 * - onShutdown(): closes the pool on graceful shutdown
 */
@Injectable()
export class DatabaseService implements Queryable, OnInit, OnShutdown {
  private readonly logger: Logger;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PG_REPLICA_POOL) private readonly replicaPool: Pool | null,
    logger: Logger
  ) {
    this.logger = logger.child("Database");
  }

  /**
   * The replica with READ_ROUTING=replica, otherwise the primary. A replica can be behind the
   * primary: never use it to read what this request, or this user a moment ago, just wrote.
   */
  get reader(): Queryable {
    return this.replicaPool ?? this;
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /**
   * Usage (in a Service):
   *   return this.database.transaction(async (client) => {
   *     await this.seatsModel.markSold(seatIds, client);
   *     return this.ordersModel.create(order, client);
   *   });
   * If the callback throws, everything it did is rolled back.
   */
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      // Always give the connection back, or the pool runs dry.
      client.release();
    }
  }

  async onInit(): Promise<void> {
    await this.pool.query("SELECT 1");
    this.logger.info("Connected to PostgreSQL");
    if (this.replicaPool) {
      await this.replicaPool.query("SELECT 1");
      this.logger.info("Connected to the PostgreSQL replica");
    }
  }

  async onShutdown(): Promise<void> {
    await this.pool.end();
    await this.replicaPool?.end();
    this.logger.info("Connection pool closed");
  }
}
