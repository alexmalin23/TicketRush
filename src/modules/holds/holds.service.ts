import { ConflictException, Inject, Injectable, NotFoundException } from "../../core";
import { DatabaseService } from "../../database/database.service";
import { ENV, Env } from "../../config/env";
import { EventsModel } from "../events/events.model";
import { HeldSeat, SeatsModel } from "../seats/seats.model";

export interface HoldResult {
  seats: Omit<HeldSeat, "heldUntil">[];
  expiresAt: Date;
}

/** Holds are additive and never extended, so each seat keeps its own expiry. */
export interface MyHolds {
  seats: (Omit<HeldSeat, "heldUntil"> & { expiresAt: Date })[];
  /** The next seat to expire, or null when the buyer holds nothing. */
  expiresAt: Date | null;
}

@Injectable()
export class HoldsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly database: DatabaseService,
    private readonly eventsModel: EventsModel,
    private readonly seatsModel: SeatsModel
  ) {}

  async hold(eventId: number, userId: number, seatIds: number[]): Promise<HoldResult> {
    const event = await this.requireOnSale(eventId);
    return this.holdSeatsSafely(eventId, userId, seatIds, event.maxSeatsPerUser);
  }

  /**
   * All-or-nothing hold that stays correct under any concurrency. One transaction:
   * any throw inside rolls back every seat it took.
   */
  private async holdSeatsSafely(
    eventId: number,
    userId: number,
    seatIds: number[],
    maxSeatsPerUser: number
  ): Promise<HoldResult> {
    // Same order for every request: two buyers asking for [1, 2] and [2, 1] lock row 1 first,
    // so one waits for the other instead of each holding the row the other needs (deadlock).
    const ids = [...seatIds].sort((a, b) => a - b);

    return this.database.transaction(async (client) => {
      // One buyer's holds run one at a time: otherwise two parallel requests both count
      // "4 owned" and both add 2, ending at 8 with a limit of 6 (read-then-write again).
      await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);

      const owned = await this.seatsModel.countUserSeats(eventId, userId, client);
      if (owned + ids.length > maxSeatsPerUser) {
        throw new ConflictException(
          `At most ${maxSeatsPerUser} seats per buyer for this event`,
          { limit: maxSeatsPerUser, owned, requested: ids.length },
          "HOLD_LIMIT_EXCEEDED"
        );
      }

      // The availability check and the write are one statement: a seat taken a microsecond
      // earlier by someone else simply does not match the WHERE clause.
      const held = await this.seatsModel.holdSeatsIfAvailable(eventId, ids, userId, this.env.HOLD_TTL_SECONDS, client);
      if (held.length < ids.length) {
        const taken = new Set(held.map((seat) => seat.id));
        // Throwing rolls back the seats this statement did take: nothing stays half-held.
        throw new ConflictException(
          "Some seats cannot be held",
          { seatIds: ids.filter((id) => !taken.has(id)) },
          "SEAT_UNAVAILABLE"
        );
      }
      return toResult(held);
    });
  }

  async myHolds(eventId: number, userId: number): Promise<MyHolds> {
    await this.requireEvent(eventId);
    const held = await this.seatsModel.activeHoldsOf(eventId, userId);
    return {
      seats: held.map(({ heldUntil, ...seat }) => ({ ...seat, expiresAt: heldUntil })),
      expiresAt: held[0]?.heldUntil ?? null,
    };
  }

  /** Idempotent: releasing seats the buyer does not hold (anymore) is not an error. */
  async release(eventId: number, userId: number, seatIds: number[] | null): Promise<void> {
    await this.requireEvent(eventId);
    await this.seatsModel.releaseHoldsOf(eventId, userId, seatIds);
  }

  private async requireEvent(eventId: number) {
    const event = await this.eventsModel.findById(eventId);
    if (!event) throw new NotFoundException(`Event ${eventId} not found`);
    return event;
  }

  private async requireOnSale(eventId: number) {
    const event = await this.requireEvent(eventId);
    if (event.status !== "onsale" || event.onsaleAt > new Date()) {
      throw new ConflictException("Event is not on sale", { status: event.status, onsaleAt: event.onsaleAt }, "EVENT_NOT_ON_SALE");
    }
    return event;
  }
}

function toResult(held: HeldSeat[]): HoldResult {
  return {
    seats: held.map(({ heldUntil: _heldUntil, ...seat }) => seat),
    expiresAt: held[0].heldUntil,
  };
}
