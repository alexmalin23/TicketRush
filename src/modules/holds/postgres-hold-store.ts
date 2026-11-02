import { ConflictException, Inject, Injectable } from "../../core";
import { ENV, Env } from "../../config/env";
import type { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";
import { HeldSeat, SeatsModel, SeatView, SectionAvailability } from "../seats/seats.model";
import type { HoldStore } from "./hold-store";

/** Holds as seat rows (status 'held', held_by, held_until): the stage 1 design, kept as the baseline. */
@Injectable()
export class PostgresHoldStore implements HoldStore {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly database: DatabaseService,
    private readonly seatsModel: SeatsModel
  ) {}

  /**
   * All-or-nothing hold that stays correct under any concurrency. One transaction:
   * any throw inside rolls back every seat it took.
   */
  hold(eventId: number, userId: number, seatIds: number[], maxSeatsPerUser: number): Promise<HeldSeat[]> {
    // Same order for every request: two buyers asking for [1, 2] and [2, 1] lock row 1 first,
    // so one waits for the other instead of each holding the row the other needs (deadlock).
    const ids = [...seatIds].sort((a, b) => a - b);

    return this.database.transaction(async (client) => {
      // One buyer's holds run one at a time: otherwise two parallel requests both count
      // "4 owned" and both add 2, ending at 8 with a limit of 6 (read-then-write again).
      await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);

      const owned = await this.seatsModel.countUserSeats(eventId, userId, client);
      if (owned + ids.length > maxSeatsPerUser) {
        throw holdLimitExceeded(maxSeatsPerUser, owned, ids.length);
      }

      // The availability check and the write are one statement: a seat taken a microsecond
      // earlier by someone else simply does not match the WHERE clause.
      const held = await this.seatsModel.holdSeatsIfAvailable(eventId, ids, userId, this.env.HOLD_TTL_SECONDS, client);
      if (held.length < ids.length) {
        const taken = new Set(held.map((seat) => seat.id));
        // Throwing rolls back the seats this statement did take: nothing stays half-held.
        throw seatUnavailable(ids.filter((id) => !taken.has(id)));
      }
      return held;
    });
  }

  activeHolds(eventId: number, userId: number): Promise<HeldSeat[]> {
    return this.seatsModel.activeHoldsOf(eventId, userId);
  }

  async release(eventId: number, userId: number, seatIds: number[] | null): Promise<void> {
    await this.seatsModel.releaseHoldsOf(eventId, userId, seatIds);
  }

  async claimForOrder(eventId: number, userId: number, seatIds: number[], db: Queryable) {
    // FOR UPDATE: two orders for the same seats serialize here; the second one waits, then sees the first.
    const held = await this.seatsModel.lockSeatsHeldByUser(eventId, userId, seatIds, db);
    // Payment can take seconds; the hold must outlive it or the seats could be sold to someone else.
    if (held.length === seatIds.length) await this.seatsModel.extendHolds(seatIds, this.env.HOLD_TTL_SECONDS, db);
    return held;
  }

  sell(userId: number, seatIds: number[], db: Queryable): Promise<number> {
    return this.seatsModel.sellHeldSeats(userId, seatIds, db);
  }

  availability(eventId: number): Promise<SectionAvailability[]> {
    return this.seatsModel.availabilityByEvent(eventId);
  }

  seatMap(eventId: number, section: string): Promise<SeatView[]> {
    return this.seatsModel.bySection(eventId, section);
  }
}

export const holdLimitExceeded = (limit: number, owned: number, requested: number) =>
  new ConflictException(`At most ${limit} seats per buyer for this event`, { limit, owned, requested }, "HOLD_LIMIT_EXCEEDED");

export const seatUnavailable = (seatIds: number[]) =>
  new ConflictException("Some seats cannot be held", { seatIds }, "SEAT_UNAVAILABLE");
