import { ENV, Env } from "../../config/env";
import { Inject, Injectable } from "../../core";
import { RedisService } from "../../database/redis.service";
import { SeatView, SectionAvailability } from "../seats/seats.model";

type SeatLayout = Omit<SeatView, "status">;

/** Every key carries the event's hash tag, so resetting an event clears them with its other keys. */
const keys = {
  /** Hash: section -> "available/total". */
  counts: (eventId: number) => `availability:{${eventId}}:counts`,
  /** JSON of a section's seats without their status. Seats never move: lives as long as an event entry. */
  layout: (eventId: number, section: string) => `section-layout:{${eventId}}:${section}`,
  /** One bit per seat, in layout order: 1 = available. Goes stale fast: AVAILABILITY_CACHE_TTL_MS. */
  free: (eventId: number, section: string) => `section-free:{${eventId}}:${section}`,
};

/** A bitmap Redis can also address with SETBIT: bit 0 is the highest bit of the first byte. */
const isSet = (bits: Buffer, i: number) => (bits[i >> 3] & (128 >> (i & 7))) !== 0;

function toBitmap(seats: SeatView[]): Buffer {
  const bits = Buffer.alloc(Math.ceil(seats.length / 8));
  seats.forEach((seat, i) => {
    if (seat.status === "available") bits[i >> 3] |= 128 >> (i & 7);
  });
  return bits;
}

/**
 * Cache-aside for what browsing reads most. A displayed seat can be up to AVAILABILITY_CACHE_TTL_MS
 * old; that only changes what a buyer sees, since the hold itself decides who gets the seat. A cache
 * that cannot answer is a miss, not an error: `load` reads the hold store as usual.
 */
@Injectable()
export class SeatCache {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService
  ) {}

  async availability(eventId: number, load: () => Promise<SectionAvailability[]>): Promise<SectionAvailability[]> {
    if (!this.env.CACHE_ENABLED) return load();

    const key = keys.counts(eventId);
    const cached = await this.redis.client.hgetall(key).catch(() => ({} as Record<string, string>));
    const sections = Object.keys(cached).sort();
    if (sections.length > 0) {
      return sections.map((name) => {
        const [available, total] = cached[name].split("/").map(Number);
        return { name, available, total };
      });
    }

    const rows = await load();
    if (rows.length > 0) {
      // One transaction: a crash between the two commands would leave counts that never expire.
      await this.redis.client
        .multi()
        .hset(key, Object.fromEntries(rows.map((s) => [s.name, `${s.available}/${s.total}`])))
        .pexpire(key, this.env.AVAILABILITY_CACHE_TTL_MS)
        .exec()
        .catch(() => undefined);
    }
    return rows;
  }

  async seatMap(eventId: number, section: string, load: () => Promise<SeatView[]>): Promise<SeatView[]> {
    if (!this.env.CACHE_ENABLED) return load();

    const layoutKey = keys.layout(eventId, section);
    const freeKey = keys.free(eventId, section);
    const [layout, free] = await Promise.all([this.redis.client.get(layoutKey), this.redis.client.getBuffer(freeKey)]).catch(() => [null, null]);
    if (layout && free) {
      return (JSON.parse(layout) as SeatLayout[]).map((seat, i) => ({
        ...seat,
        status: isSet(free, i) ? "available" : "unavailable",
      }));
    }

    const seats = await load();
    if (seats.length > 0) {
      const withoutStatus = seats.map(({ status: _status, ...seat }) => seat);
      await this.redis.client
        .multi()
        .set(layoutKey, JSON.stringify(withoutStatus), "EX", this.env.EVENT_CACHE_TTL_SECONDS)
        .set(freeKey, toBitmap(seats), "PX", this.env.AVAILABILITY_CACHE_TTL_MS)
        .exec()
        .catch(() => undefined);
    }
    return seats;
  }
}
