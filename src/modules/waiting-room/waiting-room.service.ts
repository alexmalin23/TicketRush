import jwt from "jsonwebtoken";
import { ENV, Env } from "../../config/env";
import { HttpException, Inject, Injectable, Logger, NotFoundException, OnInit, OnShutdown } from "../../core";
import { RedisService } from "../../database/redis.service";

const ACCESS_TOKEN_AUDIENCE = "waiting-room";
const ADMIT_CHECK_MS = 250;

export const waitingRoomKeys = {
  /** Sorted set: buyers in line, scored by arrival. */
  line: (eventId: number) => `waiting-room:{${eventId}}:line`,
  /** Sorted set: admitted buyers, scored by when their access ends. */
  admitted: (eventId: number) => `waiting-room:{${eventId}}:admitted`,
  /** Exists for one second after an admission: every replica runs the loop, one batch goes through. */
  tick: (eventId: number) => `waiting-room:{${eventId}}:tick`,
  /** Events with a line. Never shrinks: an empty line costs one no-op script per event per check. */
  events: "waiting-room:events",
};

/**
 * Returns the buyer's rank in line, or -1 if already admitted. ZADD NX keeps the first arrival time, so
 * joining again never moves a buyer back. Time comes from Redis, so replicas' clocks cannot reorder the line.
 */
const JOIN = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local access = redis.call('ZSCORE', KEYS[2], ARGV[1])
if access and tonumber(access) > now then return -1 end
redis.call('ZADD', KEYS[1], 'NX', now, ARGV[1])
return redis.call('ZRANK', KEYS[1], ARGV[1])
`;

/**
 * One batch per second, however many replicas run it: the tick key and the move are one step, so two
 * replicas cannot both admit, and a crash cannot pop a buyer without admitting them.
 * ARGV: [batch size, access ms]. Returns the number admitted, or -1 if this second's batch already went.
 */
const ADMIT = `
if not redis.call('SET', KEYS[3], '1', 'PX', 1000, 'NX') then return -1 end
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, now)
local popped = redis.call('ZPOPMIN', KEYS[1], ARGV[1])
for i = 1, #popped, 2 do
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), popped[i])
end
return #popped / 2
`;

export type QueueStatus =
  | { admitted: false; position: number; estimatedWaitSeconds: number }
  | { admitted: true; accessToken: string; expiresAt: Date };

/** Lets buyers in at a rate the system can serve; the rest wait in Redis, at the cost of a poll. */
@Injectable()
export class WaitingRoomService implements OnInit, OnShutdown {
  private readonly logger: Logger;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    logger: Logger,
    private readonly redis: RedisService
  ) {
    this.logger = logger.child("WaitingRoom");
  }

  onInit(): void {
    if (!this.env.WAITING_ROOM_ENABLED || this.env.WAITING_ROOM_ADMIT_PER_SECOND === 0) return;
    this.timer = setInterval(() => void this.admitAll(), ADMIT_CHECK_MS);
    this.timer.unref();
  }

  onShutdown(): void {
    clearInterval(this.timer);
  }

  private async admitAll(): Promise<void> {
    try {
      for (const id of await this.redis.client.smembers(waitingRoomKeys.events)) await this.admit(Number(id));
    } catch (error) {
      this.logger.warn("Admission check failed", { error: String(error) }); // the next check tries again
    }
  }

  admit(eventId: number, batch = this.env.WAITING_ROOM_ADMIT_PER_SECOND): Promise<number> {
    const { line, admitted, tick } = waitingRoomKeys;
    return this.redis.client.eval(
      ADMIT,
      3,
      line(eventId),
      admitted(eventId),
      tick(eventId),
      batch,
      this.env.ACCESS_TOKEN_TTL_SECONDS * 1000
    ) as Promise<number>;
  }

  /** Safe to call again: a buyer keeps their place. */
  async join(eventId: number, userId: number): Promise<{ position: number; estimatedWaitSeconds: number }> {
    await this.redis.client.sadd(waitingRoomKeys.events, eventId);
    const { line, admitted } = waitingRoomKeys;
    const rank = (await this.redis.client.eval(JOIN, 2, line(eventId), admitted(eventId), userId)) as number;
    return rank < 0 ? { position: 0, estimatedWaitSeconds: 0 } : this.place(rank);
  }

  async status(eventId: number, userId: number): Promise<QueueStatus> {
    const { line, admitted } = waitingRoomKeys;
    const [access, rank] = await Promise.all([
      this.redis.client.zscore(admitted(eventId), userId),
      this.redis.client.zrank(line(eventId), userId),
    ]);
    if (access && Number(access) > Date.now()) {
      const expiresAt = new Date(Number(access));
      return { admitted: true, accessToken: this.signAccess(eventId, userId, expiresAt), expiresAt };
    }
    if (rank === null) throw new NotFoundException("Not in line for this event", undefined, "NOT_IN_QUEUE");
    return { admitted: false, ...this.place(rank) };
  }

  private place(rank: number) {
    return { position: rank + 1, estimatedWaitSeconds: Math.ceil((rank + 1) / Math.max(this.env.WAITING_ROOM_ADMIT_PER_SECOND, 1)) };
  }

  private signAccess(eventId: number, userId: number, expiresAt: Date): string {
    return jwt.sign({ eventId, exp: Math.floor(expiresAt.getTime() / 1000) }, this.env.JWT_SECRET, {
      subject: String(userId),
      audience: ACCESS_TOKEN_AUDIENCE, // a login token must not pass as an access token, or the reverse
      algorithm: "HS256",
    });
  }

  /** The signature needs no Redis: holds keep working for admitted buyers during a Redis outage. */
  assertAccess(token: string | undefined, eventId: number, userId: number): void {
    try {
      const claims = jwt.verify(token ?? "", this.env.JWT_SECRET, { algorithms: ["HS256"], audience: ACCESS_TOKEN_AUDIENCE }) as jwt.JwtPayload;
      if (claims.sub === String(userId) && claims.eventId === eventId) return;
    } catch {
      // Same answer as a token for someone else.
    }
    throw new HttpException(403, "A valid access token from the waiting room is required", undefined, "ACCESS_TOKEN_REQUIRED");
  }
}
