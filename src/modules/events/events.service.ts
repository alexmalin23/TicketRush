import { ENV, Env } from "../../config/env";
import { Inject, Injectable, NotFoundException } from "../../core";
import { RedisService } from "../../database/redis.service";
import { HOLD_STORE, HoldStore } from "../holds/hold-store";
import { SeatsModel, SeatView, SectionAvailability, SectionPrice } from "../seats/seats.model";
import { EventDetail, EventsModel, EventSummary } from "./events.model";
import { SeatCache } from "./seat-cache";

/** Carries the event's hash tag, so resetting an event clears it with the event's other keys. */
export const eventCacheKey = (id: number) => `event:{${id}}:details`;

@Injectable()
export class EventsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService,
    private readonly seatCache: SeatCache,
    private readonly eventsModel: EventsModel,
    private readonly seatsModel: SeatsModel,
    // Which seats are free depends on where holds live.
    @Inject(HOLD_STORE) private readonly holds: HoldStore
  ) {}

  findAll(): Promise<EventSummary[]> {
    return this.eventsModel.findAll();
  }

  async findOne(id: number): Promise<EventDetail & { sections: SectionPrice[]; waitingRoomEnabled: boolean }> {
    const event = await this.requireEvent(id);
    return { ...event, waitingRoomEnabled: this.env.WAITING_ROOM_ENABLED, sections: await this.seatsModel.sectionPrices(id) };
  }

  /** The cheap summary: counts only, so clients can poll it without loading every seat. */
  async availability(id: number): Promise<{ sections: SectionAvailability[] }> {
    await this.requireEvent(id);
    return { sections: await this.seatCache.availability(id, () => this.holds.availability(id)) };
  }

  async seatMap(id: number, section: string): Promise<{ section: string; seats: SeatView[] }> {
    await this.requireEvent(id);
    const seats = await this.seatCache.seatMap(id, section, () => this.holds.seatMap(id, section));
    if (seats.length === 0) throw new NotFoundException(`Section ${section} not found`);
    return { section, seats };
  }

  private async requireEvent(id: number): Promise<EventDetail> {
    const event = await this.readEvent(id);
    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return event;
  }

  /**
   * Cache-aside: Redis first, Postgres on a miss, then fill Redis. Only for browsing: whether a
   * buyer may hold or order is still decided from Postgres. A cache that cannot answer is a miss,
   * not an error, so a Redis outage slows browsing down instead of breaking it.
   */
  private async readEvent(id: number): Promise<EventDetail | null> {
    if (!this.env.CACHE_ENABLED) return this.eventsModel.findById(id);

    const key = eventCacheKey(id);
    const cached = await this.redis.client.get(key).catch(() => null);
    if (cached) {
      const event = JSON.parse(cached) as EventDetail;
      return { ...event, startsAt: new Date(event.startsAt), onsaleAt: new Date(event.onsaleAt) };
    }

    const event = await this.eventsModel.findById(id);
    if (event) {
      await this.redis.client.set(key, JSON.stringify(event), "EX", this.env.EVENT_CACHE_TTL_SECONDS).catch(() => undefined);
    }
    return event;
  }
}
