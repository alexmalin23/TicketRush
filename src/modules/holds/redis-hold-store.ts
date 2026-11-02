import { Inject, Injectable } from "../../core";
import { ENV, Env } from "../../config/env";
import type { Queryable } from "../../database/database.constants";
import { RedisService } from "../../database/redis.service";
import { HeldSeat, SeatsModel, SeatView, SectionAvailability } from "../seats/seats.model";
import type { HoldStore } from "./hold-store";
import { holdLimitExceeded, seatUnavailable } from "./postgres-hold-store";

/**
 * Keys of one event. The braces are a Redis Cluster hash tag: every key of an event lands on the
 * same node, which a script touching several of them requires.
 */
export const holdKeys = {
  /** The hold itself: value = buyer id, TTL = the hold's lifetime. The source of truth. */
  seat: (eventId: number, seatId: number) => `seat-hold:{${eventId}}:${seatId}`,
  /** Index: the buyer's held seats, score = expiry (ms). For "my holds" and the per-buyer limit. */
  user: (eventId: number, userId: number) => `user-holds:{${eventId}}:${userId}`,
  /** Index: held seats of a section, score = expiry (ms). For the seat map and availability. */
  section: (eventId: number, section: string) => `section-holds:{${eventId}}:${section}`,
};

/**
 * Holds every seat or none, within the buyer's limit, in one step no other request can interleave.
 *
 * KEYS: [userKey, seatKey1..seatKeyN, sectionKey1..sectionKeyN]  (sectionKey i belongs to seat i)
 * ARGV: [userId, ttlMs, maxSeatsPerUser, boughtSeats, seatId1..seatIdN]
 * Returns: {0, expiresAtMs}          every seat held, all with this expiry
 *          {1, owned}                 limit exceeded: owned = unexpired holds + bought seats
 *          {2, seatId, seatId, ...}   these seats are held by someone else; nothing was held
 */
const HOLD_SEATS = `
local n = (#KEYS - 1) / 2
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local expiresAt = now + tonumber(ARGV[2])

-- Every check before any write: a refusal leaves nothing behind (all or nothing).
local owned = redis.call('ZCOUNT', KEYS[1], now, '+inf') + tonumber(ARGV[4])
if owned + n > tonumber(ARGV[3]) then
  return {1, owned}
end

local taken = {}
for i = 1, n do
  if redis.call('EXISTS', KEYS[1 + i]) == 1 then
    table.insert(taken, ARGV[4 + i])
  end
end
if #taken > 0 then
  return {2, unpack(taken)}
end

for i = 1, n do
  redis.call('SET', KEYS[1 + i], ARGV[1], 'PX', ARGV[2])
  redis.call('ZADD', KEYS[1], expiresAt, ARGV[4 + i])
  redis.call('ZADD', KEYS[1 + n + i], expiresAt, ARGV[4 + i])
  -- An index lives as long as its latest hold: no key outlives the holds it lists.
  redis.call('PEXPIREAT', KEYS[1], expiresAt)
  redis.call('PEXPIREAT', KEYS[1 + n + i], expiresAt)
end
return {0, expiresAt}
`;

/**
 * Proves the buyer still holds every seat and, only then, gives them all a fresh expiry for the
 * payment. Check and extend are one step: a hold cannot expire, or be taken, between the two.
 *
 * KEYS/ARGV as HOLD_SEATS, ARGV: [userId, ttlMs, seatId1..N]
 * Returns: {0, expiresAtMs}          every seat held by this buyer, all extended
 *          {1, seatId, seatId, ...}   these seats are not held by this buyer; nothing was extended
 */
const CLAIM_SEATS = `
local n = (#KEYS - 1) / 2
local lost = {}
for i = 1, n do
  if redis.call('GET', KEYS[1 + i]) ~= ARGV[1] then
    table.insert(lost, ARGV[2 + i])
  end
end
if #lost > 0 then
  return {1, unpack(lost)}
end

local time = redis.call('TIME')
local expiresAt = time[1] * 1000 + math.floor(time[2] / 1000) + tonumber(ARGV[2])
for i = 1, n do
  redis.call('PEXPIREAT', KEYS[1 + i], expiresAt)
  redis.call('ZADD', KEYS[1], expiresAt, ARGV[2 + i])
  redis.call('ZADD', KEYS[1 + n + i], expiresAt, ARGV[2 + i])
  redis.call('PEXPIREAT', KEYS[1], expiresAt)
  redis.call('PEXPIREAT', KEYS[1 + n + i], expiresAt)
end
return {0, expiresAt}
`;

/** Releases seats only if this buyer still holds them. KEYS/ARGV as HOLD_SEATS, ARGV: [userId, seatId1..N]. */
const RELEASE_SEATS = `
local n = (#KEYS - 1) / 2
for i = 1, n do
  if redis.call('GET', KEYS[1 + i]) == ARGV[1] then
    redis.call('DEL', KEYS[1 + i])
  end
  -- Index entries go either way: a seat no longer held by this buyer must not stay in their list.
  redis.call('ZREM', KEYS[1], ARGV[1 + i])
  if redis.call('EXISTS', KEYS[1 + i]) == 0 then
    redis.call('ZREM', KEYS[1 + n + i], ARGV[1 + i])
  end
end
return n
`;

/**
 * Holds as Redis keys with a TTL: expiry is Redis deleting the key, with no row to update. Postgres
 * keeps only available / sold for these seats; selling re-checks the hold here and the seat there.
 */
@Injectable()
export class RedisHoldStore implements HoldStore {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService,
    private readonly seatsModel: SeatsModel
  ) {}

  async hold(eventId: number, userId: number, seatIds: number[], maxSeatsPerUser: number): Promise<HeldSeat[]> {
    const ids = [...new Set(seatIds)].sort((a, b) => a - b);
    const seats = await this.seatsModel.findByIds(eventId, ids);
    // Unknown ids and sold seats are unavailable, the same answer the Postgres store gives.
    const sold = new Set(await this.seatsModel.soldAmong(eventId, ids));
    const missing = ids.filter((id) => !seats.some((seat) => seat.id === id) || sold.has(id));
    if (missing.length > 0) throw seatUnavailable(missing);

    // Read before the script, so a sale completing in between can be missed by the limit;
    // see the order flow for how holds are removed after a sale.
    const bought = await this.seatsModel.countBoughtSeats(eventId, userId);
    const result = (await this.redis.client.eval(
      HOLD_SEATS,
      1 + 2 * seats.length,
      holdKeys.user(eventId, userId),
      ...seats.map((seat) => holdKeys.seat(eventId, seat.id)),
      ...seats.map((seat) => holdKeys.section(eventId, seat.section)),
      userId,
      this.env.HOLD_TTL_SECONDS * 1000,
      maxSeatsPerUser,
      bought,
      ...seats.map((seat) => seat.id)
    )) as number[];

    const [status, ...rest] = result.map(Number);
    if (status === 1) throw holdLimitExceeded(maxSeatsPerUser, rest[0], ids.length);
    if (status === 2) throw seatUnavailable(rest);
    const heldUntil = new Date(rest[0]);
    return seats.map((seat) => ({ ...seat, heldUntil }));
  }

  async activeHolds(eventId: number, userId: number): Promise<HeldSeat[]> {
    const expiries = await this.unexpired(holdKeys.user(eventId, userId));
    if (expiries.size === 0) return [];
    // The index can lag behind a hold that expired or was taken over; the seat key decides.
    const ids = [...expiries.keys()];
    const owners = await this.redis.client.mget(ids.map((id) => holdKeys.seat(eventId, id)));
    const mine = ids.filter((_, i) => owners[i] === String(userId));
    const seats = await this.seatsModel.findByIds(eventId, mine);
    return seats
      .map((seat) => ({ ...seat, heldUntil: new Date(expiries.get(seat.id)!) }))
      .sort((a, b) => a.heldUntil.getTime() - b.heldUntil.getTime() || a.id - b.id);
  }

  async release(eventId: number, userId: number, seatIds: number[] | null): Promise<void> {
    const candidates = seatIds ?? [...(await this.unexpired(holdKeys.user(eventId, userId))).keys()];
    if (candidates.length === 0) return;
    // A seat in an order awaiting payment stays held: the buyer is being charged for it.
    const paying = new Set(await this.seatsModel.inPendingOrders(eventId, candidates));
    const seats = (await this.seatsModel.findByIds(eventId, candidates)).filter((seat) => !paying.has(seat.id));
    if (seats.length === 0) return;
    await this.redis.client.eval(
      RELEASE_SEATS,
      1 + 2 * seats.length,
      holdKeys.user(eventId, userId),
      ...seats.map((seat) => holdKeys.seat(eventId, seat.id)),
      ...seats.map((seat) => holdKeys.section(eventId, seat.section)),
      userId,
      ...seats.map((seat) => seat.id)
    );
  }

  /**
   * Two stores, two questions: Redis says who holds the seat, Postgres says whether it is still
   * unsold. The row lock comes first, so two orders for the same seats serialize on it exactly as
   * with Postgres holds; the pending-order check after this call then refuses the second one.
   */
  async claimForOrder(eventId: number, userId: number, seatIds: number[], db: Queryable) {
    const seats = await this.seatsModel.lockUnsoldSeats(eventId, seatIds, db);
    // A seat sold in Postgres is refused even if a stale Redis key still names this buyer.
    if (seats.length < seatIds.length) return seats;

    const result = (await this.redis.client.eval(
      CLAIM_SEATS,
      1 + 2 * seats.length,
      holdKeys.user(eventId, userId),
      ...seats.map((seat) => holdKeys.seat(eventId, seat.id)),
      ...seats.map((seat) => holdKeys.section(eventId, seat.section)),
      userId,
      this.env.HOLD_TTL_SECONDS * 1000,
      ...seats.map((seat) => seat.id)
    )) as number[];

    const [status, ...lost] = result.map(Number);
    return status === 0 ? seats : seats.filter((seat) => !lost.includes(seat.id));
  }

  /** Conditional on Postgres alone: the hold was proven in claimForOrder, before the charge. */
  sell(_userId: number, seatIds: number[], db: Queryable): Promise<number> {
    return this.seatsModel.sellUnsoldSeats(seatIds, db);
  }

  async availability(eventId: number): Promise<SectionAvailability[]> {
    const sections = await this.seatsModel.availabilityByEvent(eventId); // available = not sold here
    const now = Date.now();
    const held = await Promise.all(
      sections.map((s) => this.redis.client.zcount(holdKeys.section(eventId, s.name), now, "+inf"))
    );
    return sections.map((s, i) => ({ ...s, available: s.available - held[i] }));
  }

  async seatMap(eventId: number, section: string): Promise<SeatView[]> {
    const seats = await this.seatsModel.bySection(eventId, section);
    const held = await this.unexpired(holdKeys.section(eventId, section));
    return seats.map((seat) => (held.has(seat.id) ? { ...seat, status: "unavailable" } : seat));
  }

  /** seatId -> expiry (ms) of the index entries that have not expired yet. */
  private async unexpired(indexKey: string): Promise<Map<number, number>> {
    const flat = await this.redis.client.zrangebyscore(indexKey, Date.now(), "+inf", "WITHSCORES");
    const result = new Map<number, number>();
    for (let i = 0; i < flat.length; i += 2) result.set(Number(flat[i]), Number(flat[i + 1]));
    return result;
  }
}
