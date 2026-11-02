import type { FactoryProvider } from "../../core";
import { ENV, Env } from "../../config/env";
import type { Queryable } from "../../database/database.constants";
import type { HeldSeat, SeatView, SectionAvailability } from "../seats/seats.model";
import { PostgresHoldStore } from "./postgres-hold-store";
import { RedisHoldStore } from "./redis-hold-store";

/** DI token for the active hold store: constructor(@Inject(HOLD_STORE) holds: HoldStore) */
export const HOLD_STORE = "HOLD_STORE";

/**
 * Everything that knows where holds live. Postgres stays the source of truth for what is sold in
 * both stores; a hold is a temporary claim kept either in the seat rows or in Redis keys with a TTL.
 */
export interface HoldStore {
  /**
   * All or nothing, within the buyer's per-event limit (held + bought). Throws 409
   * HOLD_LIMIT_EXCEEDED or SEAT_UNAVAILABLE; on success every seat is held until the same expiry.
   */
  hold(eventId: number, userId: number, seatIds: number[], maxSeatsPerUser: number): Promise<HeldSeat[]>;
  /** The buyer's unexpired holds, earliest expiry first. */
  activeHolds(eventId: number, userId: number): Promise<HeldSeat[]>;
  /** Releases the buyer's holds (all, or only `seatIds`), except seats in an order awaiting payment. */
  release(eventId: number, userId: number, seatIds: number[] | null): Promise<void>;
  /**
   * Inside the order transaction: locks the seats this buyer holds and keeps them held long enough
   * for the payment. Returns those seats; fewer than requested means the order must be refused.
   */
  claimForOrder(eventId: number, userId: number, seatIds: number[], db: Queryable): Promise<{ id: number; priceCents: number }[]>;
  /** Inside the sale transaction: marks the claimed seats sold. Returns how many were. */
  sell(userId: number, seatIds: number[], db: Queryable): Promise<number>;
  availability(eventId: number): Promise<SectionAvailability[]>;
  seatMap(eventId: number, section: string): Promise<SeatView[]>;
}

/** Picks the store once at startup (HOLD_STORE). Registered in app.ts with the other infrastructure. */
export const holdStoreProvider: FactoryProvider = {
  provide: HOLD_STORE,
  useFactory: (env: Env, postgres: PostgresHoldStore, redis: RedisHoldStore) =>
    env.HOLD_STORE === "redis" ? redis : postgres,
  inject: [ENV, PostgresHoldStore, RedisHoldStore],
};
