import { randomUUID } from "node:crypto";
import { ENV, Env } from "../../config/env";
import { Inject, Injectable } from "../../core";
import { RedisService } from "../../database/redis.service";
import { SeatsModel, SeatView, SectionAvailability } from "../seats/seats.model";

type SeatLayout = Omit<SeatView, "status">;

/** Every key carries the event's hash tag, so resetting an event clears them with its other keys. */
export const seatCacheKeys = {
  /** Hash: section -> "available/total". */
  counts: (eventId: number) => `availability:{${eventId}}:counts`,
  /** JSON of a section's seats without their status. Seats never move: lives as long as an event entry. */
  layout: (eventId: number, section: string) => `section-layout:{${eventId}}:${section}`,
  /** One bit per seat, in layout order: 1 = available. Stale after AVAILABILITY_CACHE_TTL_MS, gone AVAILABILITY_STALE_MS later. */
  free: (eventId: number, section: string) => `section-free:{${eventId}}:${section}`,
  /** Held by the one request rebuilding an entry. `what` is "counts" or a section name. */
  rebuild: (eventId: number, what: string) => `cache-rebuild:{${eventId}}:${what}`,
  /** Exists while an entry is fresh. An entry without it is still served, while one request refreshes it. */
  fresh: (eventId: number, what: string) => `cache-fresh:{${eventId}}:${what}`,
};

export const REBUILD_LOCK_TTL_MS = 2000;
export const REBUILD_WAIT_MS = 1000;
export const REBUILD_POLL_MS = 25;

/** Compare and delete as one step: a holder that outlived its TTL must not free the next holder's lock. */
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Entries written together, as after a cold start, must not all expire in the same instant. */
const withJitter = (ms: number) => Math.round(ms * (0.9 + Math.random() * 0.2));

const isSet = (bits: Buffer, i: number) => (bits[i >> 3] & (128 >> (i & 7))) !== 0;

function toBitmap(seats: SeatView[]): Buffer {
  const bits = Buffer.alloc(Math.ceil(seats.length / 8));
  seats.forEach((seat, i) => {
    if (seat.status === "available") bits[i >> 3] |= 128 >> (i & 7);
  });
  return bits;
}

/**
 * Cache-aside for what browsing reads most. A displayed seat is at most about
 * 1.1 x AVAILABILITY_CACHE_TTL_MS + AVAILABILITY_STALE_MS old: every entry expires, so even a rebuild that
 * read before a hold and wrote after its invalidation cannot outlive that. Staleness only changes what a
 * buyer sees, since the hold itself decides who gets the seat. A cache that cannot answer is a miss, not
 * an error: `load` reads the hold store as usual.
 */
@Injectable()
export class SeatCache {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService,
    private readonly seats: SeatsModel
  ) {}

  async availability(eventId: number, load: () => Promise<SectionAvailability[]>): Promise<SectionAvailability[]> {
    if (!this.env.CACHE_ENABLED) return load();

    return this.serve(eventId, "counts", () => this.readCounts(eventId), async () => {
      const rows = await load();
      await this.writeCounts(eventId, rows);
      return rows;
    });
  }

  async seatMap(eventId: number, section: string, load: () => Promise<SeatView[]>): Promise<SeatView[]> {
    if (!this.env.CACHE_ENABLED) return load();

    return this.serve(eventId, section, () => this.readSeatMap(eventId, section), async () => {
      const seats = await load();
      await this.writeSeatMap(eventId, section, seats);
      return seats;
    });
  }

  /** A hold or release changed these sections: the buyer who just acted must not see the old state. */
  async invalidate(eventId: number, sections: string[]): Promise<void> {
    if (!this.env.CACHE_ENABLED || sections.length === 0) return;
    const { counts, free, fresh } = seatCacheKeys;
    await this.redis.client
      .unlink(counts(eventId), fresh(eventId, "counts"), ...sections.flatMap((s) => [free(eventId, s), fresh(eventId, s)]))
      .catch(() => undefined); // the TTL still bounds how long the old state shows
  }

  /** Same, when only seat ids are known; null means every section of the event. */
  async invalidateSeats(eventId: number, seatIds: number[] | null): Promise<void> {
    if (!this.env.CACHE_ENABLED) return;
    await this.invalidate(eventId, await this.seats.sectionsOf(eventId, seatIds));
  }

  /** Fresh entry: answer. Stale entry: answer now and let one request refresh it. No entry: wait for a rebuild. */
  private async serve<T>(eventId: number, what: string, read: () => Promise<T | null>, rebuild: () => Promise<T>): Promise<T> {
    const lockKey = seatCacheKeys.rebuild(eventId, what);
    const [entry, fresh] = await Promise.all([read(), this.redis.client.exists(seatCacheKeys.fresh(eventId, what)).catch(() => 0)]);
    if (!entry) return this.singleFlight(lockKey, read, rebuild);
    if (!fresh) void this.refresh(lockKey, rebuild);
    return entry;
  }

  private async refresh<T>(lockKey: string, rebuild: () => Promise<T>): Promise<void> {
    const owner = randomUUID();
    const locked = await this.redis.client.set(lockKey, owner, "PX", REBUILD_LOCK_TTL_MS, "NX").catch(() => null);
    // Nobody waits on this query; if it fails the entry keeps expiring and the next miss reports the error.
    if (locked) await this.rebuildHoldingLock(lockKey, owner, async () => null, rebuild).catch(() => undefined);
  }

  /**
   * Lets one request rebuild an expired entry while the others wait for its result, so an expiry
   * costs one query however many requests arrive during it.
   */
  private async singleFlight<T>(lockKey: string, read: () => Promise<T | null>, rebuild: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const deadline = Date.now() + REBUILD_WAIT_MS;
    while (Date.now() < deadline) {
      let locked: string | null;
      try {
        locked = await this.redis.client.set(lockKey, owner, "PX", REBUILD_LOCK_TTL_MS, "NX");
      } catch {
        return rebuild(); // no Redis, no lock: a query per request beats no answer
      }
      if (locked) return this.rebuildHoldingLock(lockKey, owner, read, rebuild);

      await new Promise((resolve) => setTimeout(resolve, REBUILD_POLL_MS));
      const entry = await read();
      if (entry) return entry;
    }
    return rebuild(); // the holder is stuck or dead: a slow answer beats none
  }

  private async rebuildHoldingLock<T>(lockKey: string, owner: string, read: () => Promise<T | null>, rebuild: () => Promise<T>): Promise<T> {
    try {
      // The previous holder may have finished between this request's miss and its lock.
      return (await read()) ?? (await rebuild());
    } finally {
      await this.redis.client.eval(RELEASE_LOCK, 1, lockKey, owner).catch(() => undefined);
    }
  }

  private async readCounts(eventId: number): Promise<SectionAvailability[] | null> {
    const cached = await this.redis.client.hgetall(seatCacheKeys.counts(eventId)).catch(() => ({} as Record<string, string>));
    const sections = Object.keys(cached).sort();
    if (sections.length === 0) return null;
    return sections.map((name) => {
      const [available, total] = cached[name].split("/").map(Number);
      return { name, available, total };
    });
  }

  private async writeCounts(eventId: number, rows: SectionAvailability[]): Promise<void> {
    if (rows.length === 0) return;
    const key = seatCacheKeys.counts(eventId);
    const ttl = withJitter(this.env.AVAILABILITY_CACHE_TTL_MS);
    // One transaction: a crash between the two commands would leave counts that never expire.
    await this.redis.client
      .multi()
      .del(key) // a hash merges: a section that left the answer must not stay in the entry
      .hset(key, Object.fromEntries(rows.map((s) => [s.name, `${s.available}/${s.total}`])))
      .pexpire(key, ttl + this.env.AVAILABILITY_STALE_MS)
      .set(seatCacheKeys.fresh(eventId, "counts"), "1", "PX", ttl)
      .exec()
      .catch(() => undefined);
  }

  private async readSeatMap(eventId: number, section: string): Promise<SeatView[] | null> {
    const [layout, free] = await Promise.all([
      this.redis.client.get(seatCacheKeys.layout(eventId, section)),
      this.redis.client.getBuffer(seatCacheKeys.free(eventId, section)),
    ]).catch(() => [null, null]);
    if (!layout || !free) return null;
    return (JSON.parse(layout) as SeatLayout[]).map((seat, i) => ({
      ...seat,
      status: isSet(free, i) ? "available" : "unavailable",
    }));
  }

  private async writeSeatMap(eventId: number, section: string, seats: SeatView[]): Promise<void> {
    if (seats.length === 0) return;
    const withoutStatus = seats.map(({ status: _status, ...seat }) => seat);
    const ttl = withJitter(this.env.AVAILABILITY_CACHE_TTL_MS);
    await this.redis.client
      .multi()
      .set(seatCacheKeys.layout(eventId, section), JSON.stringify(withoutStatus), "EX", this.env.EVENT_CACHE_TTL_SECONDS)
      .set(seatCacheKeys.free(eventId, section), toBitmap(seats), "PX", ttl + this.env.AVAILABILITY_STALE_MS)
      .set(seatCacheKeys.fresh(eventId, section), "1", "PX", ttl)
      .exec()
      .catch(() => undefined);
  }
}
