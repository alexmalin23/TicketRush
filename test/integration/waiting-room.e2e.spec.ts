import { ModexApplication } from "../../src/core";
import { RedisService } from "../../src/database/redis.service";
import { WaitingRoomService, waitingRoomKeys } from "../../src/modules/waiting-room/waiting-room.service";
import { buildScenario, Scenario } from "../helpers/scenario";
import { bearer, createTestApp, http } from "../helpers/test-app";

const API = "/api/v1";

describe("Waiting room (e2e)", () => {
  const originalEnv = { ...process.env };
  let app: ModexApplication;
  let room: WaitingRoomService;
  let redis: RedisService;
  let s: Scenario;

  const start = async (env: Record<string, string> = {}) => {
    Object.assign(process.env, { WAITING_ROOM_ENABLED: "true", WAITING_ROOM_ADMIT_PER_SECOND: "0" }, env);
    app = await createTestApp();
    room = app.get(WaitingRoomService);
    redis = app.get(RedisService);
    await redis.client.flushdb();
    s = await buildScenario(app, 4, 5);
  };
  const queue = (_user: number) => `${API}/events/${s.eventId}/queue`;
  const join = (user: number) => http(app).post(queue(user)).set(bearer(s.tokens[user])).expect(200);
  const status = (user: number) => http(app).get(queue(user)).set(bearer(s.tokens[user]));
  const hold = (user: number, token?: string) => {
    const req = http(app).post(`${API}/events/${s.eventId}/holds`).set(bearer(s.tokens[user]));
    return (token ? req.set("X-Access-Token", token) : req).send({ seatIds: [s.seatIds[user]] });
  };
  /** Admits the next batch now: the batch is limited to one a second by a key this test may clear. */
  const admit = async (batch: number) => {
    await redis.client.del(waitingRoomKeys.tick(s.eventId));
    return room.admit(s.eventId, batch);
  };

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it("gives places in arrival order, and joining again keeps the place", async () => {
    await start({ WAITING_ROOM_ADMIT_PER_SECOND: "0" });
    const first = await join(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await join(1);
    expect([first.body.position, second.body.position]).toEqual([1, 2]);
    expect((await join(0)).body.position).toBe(1);
    expect((await status(1).expect(200)).body).toMatchObject({ admitted: false, position: 2 });
  });

  it("does not know a buyer who never joined", async () => {
    await start();
    expect((await status(0).expect(404)).body.code).toBe("NOT_IN_QUEUE");
  });

  it("admits the first in line and hands out a token that opens holds", async () => {
    await start();
    await join(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await join(1);
    await admit(1);

    const admitted = await status(0).expect(200);
    expect(admitted.body.admitted).toBe(true);
    expect((await status(1).expect(200)).body).toMatchObject({ admitted: false, position: 1 });
    await hold(0, admitted.body.accessToken).expect(201);
  });

  it("three replicas running the loop in the same second admit one batch", async () => {
    await start();
    for (let user = 0; user < 5; user++) await join(user);

    const results = await Promise.all([room.admit(s.eventId, 2), room.admit(s.eventId, 2), room.admit(s.eventId, 2)]);

    expect(results.sort()).toEqual([-1, -1, 2]);
    expect(await redis.client.zcard(waitingRoomKeys.admitted(s.eventId))).toBe(2);
    expect(await redis.client.zcard(waitingRoomKeys.line(s.eventId))).toBe(3);
  });

  it("the loop lets in about the configured number per second", async () => {
    await start({ WAITING_ROOM_ADMIT_PER_SECOND: "2" });
    for (let user = 0; user < 5; user++) await join(user);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const admitted = await redis.client.zcard(waitingRoomKeys.admitted(s.eventId));
    expect(admitted).toBeGreaterThanOrEqual(2);
    expect(admitted).toBeLessThanOrEqual(4);
  });

  it("refuses a hold without a token, with someone else's, and for another event", async () => {
    await start();
    await join(0);
    await admit(1);
    const { accessToken } = (await status(0).expect(200)).body;

    expect((await hold(0).expect(403)).body.code).toBe("ACCESS_TOKEN_REQUIRED");
    expect((await hold(1, accessToken).expect(403)).body.code).toBe("ACCESS_TOKEN_REQUIRED");
    expect((await hold(0, s.tokens[0]).expect(403)).body.code).toBe("ACCESS_TOKEN_REQUIRED"); // a login token
    const other = await http(app)
      .post(`${API}/events/${s.eventId + 1}/holds`)
      .set(bearer(s.tokens[0]))
      .set("X-Access-Token", accessToken)
      .send({ seatIds: [s.seatIds[0]] });
    expect(other.status).toBe(403);
  });

  it("access runs out, and the buyer goes to the back of the line", async () => {
    await start({ ACCESS_TOKEN_TTL_SECONDS: "1" });
    await join(0);
    await admit(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect((await join(0)).body.position).toBe(1);
    expect((await status(0).expect(200)).body.admitted).toBe(false);
  });

  it("holds need no token when the room is off", async () => {
    await start({ WAITING_ROOM_ENABLED: "false" });
    await hold(0).expect(201);
  });
});
