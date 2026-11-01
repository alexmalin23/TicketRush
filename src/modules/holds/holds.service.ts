import { ConflictException, Inject, Injectable, NotFoundException } from "../../core";
import { EventsModel } from "../events/events.model";
import type { HeldSeat } from "../seats/seats.model";
import { HOLD_STORE, HoldStore } from "./hold-store";

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
    private readonly eventsModel: EventsModel,
    @Inject(HOLD_STORE) private readonly holds: HoldStore
  ) {}

  async hold(eventId: number, userId: number, seatIds: number[]): Promise<HoldResult> {
    const event = await this.requireOnSale(eventId);
    const held = await this.holds.hold(eventId, userId, seatIds, event.maxSeatsPerUser);
    return {
      seats: held.map(({ heldUntil: _heldUntil, ...seat }) => seat),
      expiresAt: held[0].heldUntil,
    };
  }

  async myHolds(eventId: number, userId: number): Promise<MyHolds> {
    await this.requireEvent(eventId);
    const held = await this.holds.activeHolds(eventId, userId);
    return {
      seats: held.map(({ heldUntil, ...seat }) => ({ ...seat, expiresAt: heldUntil })),
      expiresAt: held[0]?.heldUntil ?? null,
    };
  }

  /** Idempotent: releasing seats the buyer does not hold (anymore) is not an error. */
  async release(eventId: number, userId: number, seatIds: number[] | null): Promise<void> {
    await this.requireEvent(eventId);
    await this.holds.release(eventId, userId, seatIds);
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
