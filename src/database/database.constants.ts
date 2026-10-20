import type { QueryResult, QueryResultRow } from "pg";

/** DI token for the shared pg Pool: constructor(@Inject(PG_POOL) pool: Pool) */
export const PG_POOL = "PG_POOL";

/**
 * Anything that can run a query: the DatabaseService (uses the pool) or a
 * PoolClient inside a transaction. Models accept a Queryable so the same
 * method works both inside and outside a transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
}
