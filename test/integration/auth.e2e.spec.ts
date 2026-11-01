import jwt from "jsonwebtoken";
import { ModexApplication } from "../../src/core";
import { RedisService } from "../../src/database/redis.service";
import { bearer, createTestApp, createUser, http, resetDatabase } from "../helpers/test-app";

const API = "/api/v1";

describe("Auth (e2e)", () => {
  let app: ModexApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(() => resetDatabase(app));
  afterAll(() => app.close());

  describe("POST /auth/register", () => {
    it("creates the account, normalizes the email and returns { id, email, accessToken }", async () => {
      const res = await http(app)
        .post(`${API}/auth/register`)
        .send({ email: "  Dana@Example.COM ", password: "password123" })
        .expect(201);

      expect(res.body).toEqual({ id: 1, email: "dana@example.com", accessToken: expect.any(String) });
    });

    it("rejects a duplicate email with 409 CONFLICT, case-insensitively", async () => {
      await createUser(app, "dana@example.com");
      const res = await http(app)
        .post(`${API}/auth/register`)
        .send({ email: "DANA@example.com", password: "password123" })
        .expect(409);
      expect(res.body.code).toBe("CONFLICT");
    });

    it("rejects invalid input with 400 VALIDATION_ERROR listing every field", async () => {
      const res = await http(app).post(`${API}/auth/register`).send({ email: "nope", password: "short" }).expect(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(["body.email", "body.password"]);
    });
  });

  describe("POST /auth/login", () => {
    it("returns { id, email, accessToken } for the right password", async () => {
      const { id } = await createUser(app, "dana@example.com", "user", "password123");
      const res = await http(app)
        .post(`${API}/auth/login`)
        .send({ email: "Dana@example.com", password: "password123" })
        .expect(200);
      expect(res.body).toEqual({ id, email: "dana@example.com", accessToken: expect.any(String) });
    });

    it("answers 401 UNAUTHORIZED with the same message for a wrong password and an unknown email", async () => {
      await createUser(app, "dana@example.com", "user", "password123");
      const wrong = await http(app).post(`${API}/auth/login`).send({ email: "dana@example.com", password: "wrong-pass" }).expect(401);
      const ghost = await http(app).post(`${API}/auth/login`).send({ email: "ghost@example.com", password: "password123" }).expect(401);

      expect(wrong.body.code).toBe("UNAUTHORIZED");
      expect(ghost.body.message).toBe(wrong.body.message); // no hint about which emails exist
    });
  });

  describe("authenticated routes", () => {
    it("GET /me returns only { id, email } of the token's user", async () => {
      const { id, token } = await createUser(app, "dana@example.com");
      await http(app).get(`${API}/me`).set(bearer(token)).expect(200, { id, email: "dana@example.com" });
    });

    it("POST /auth/logout answers 204", async () => {
      const { token } = await createUser(app, "dana@example.com");
      await http(app).post(`${API}/auth/logout`).set(bearer(token)).expect(204);
    });
  });

  describe("revocation", () => {
    const login = async (email: string) =>
      (await http(app).post(`${API}/auth/login`).send({ email, password: "password123" }).expect(200)).body.accessToken as string;

    it("a logged-out token is refused everywhere, though its signature is still valid", async () => {
      const { token } = await createUser(app, "dana@example.com");
      await http(app).post(`${API}/auth/logout`).set(bearer(token)).expect(204);

      const res = await http(app).get(`${API}/me`).set(bearer(token)).expect(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Token has been revoked" });
      await http(app).post(`${API}/auth/logout`).set(bearer(token)).expect(401);
    });

    it("logging out ends one session: the user's other tokens keep working", async () => {
      const { token: first } = await createUser(app, "dana@example.com");
      const second = await login("dana@example.com");

      await http(app).post(`${API}/auth/logout`).set(bearer(first)).expect(204);
      await http(app).get(`${API}/me`).set(bearer(second)).expect(200);
    });

    it("the denylist entry expires with the token, so the list never outgrows live tokens", async () => {
      const { token } = await createUser(app, "dana@example.com");
      await http(app).post(`${API}/auth/logout`).set(bearer(token)).expect(204);

      const { jti, exp } = jwt.decode(token) as { jti: string; exp: number };
      const ttl = await app.get(RedisService).client.ttl(`revoked-token:${jti}`);
      const remaining = exp - Math.floor(Date.now() / 1000);
      expect(ttl).toBeGreaterThan(remaining - 5);
      expect(ttl).toBeLessThanOrEqual(remaining);
    });

    it("rejects a validly signed token without an id: it could never be revoked", async () => {
      const token = jwt.sign({ email: "x", role: "user" }, process.env.JWT_SECRET!, { subject: "1", expiresIn: "1h" });
      await http(app).get(`${API}/me`).set(bearer(token)).expect(401);
    });

    it("answers 503, not 401, while Redis is unreachable: revocation cannot be checked", async () => {
      const { token } = await createUser(app, "dana@example.com");
      const redis = app.get(RedisService).client;
      redis.disconnect(); // a real lost connection, not a mock

      try {
        const res = await http(app).get(`${API}/me`).set(bearer(token)).expect(503);
        expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
        await http(app).post(`${API}/auth/logout`).set(bearer(token)).expect(503);
      } finally {
        await redis.connect();
      }
      await http(app).get(`${API}/me`).set(bearer(token)).expect(200);
    });
  });

  describe("bad tokens", () => {

    // Every way a token can be wrong, against every route that requires one.
    const routes = [
      ["get", `${API}/me`],
      ["post", `${API}/auth/logout`],
    ] as const;
    const badAuth: [string, () => Record<string, string>][] = [
      ["no Authorization header", () => ({})],
      ["a non-Bearer scheme", () => ({ Authorization: "Basic dXNlcjpwYXNz" })],
      ["a malformed token", () => bearer("not-a-jwt")],
      ["a token signed with another secret", () => bearer(jwt.sign({ email: "x", role: "admin" }, "attacker-secret-1234567", { subject: "1" }))],
      ["an expired token", () => bearer(jwt.sign({ email: "x", role: "user" }, process.env.JWT_SECRET!, { subject: "1", expiresIn: -10 }))],
      ["an unsigned token (alg: none)", () => bearer(jwt.sign({ email: "x", role: "admin" }, "", { subject: "1", algorithm: "none" }))],
    ];

    for (const [method, path] of routes) {
      for (const [label, headers] of badAuth) {
        it(`${method.toUpperCase()} ${path} rejects ${label} with 401 UNAUTHORIZED`, async () => {
          const res = await http(app)[method](path).set(headers()).expect(401);
          expect(res.body.code).toBe("UNAUTHORIZED");
        });
      }
    }
  });

  it("/users stays admin only", async () => {
    const user = await createUser(app, "user@example.com");
    const admin = await createUser(app, "admin@example.com", "admin");

    await http(app).get("/users").expect(401);
    await http(app).get("/users").set(bearer(user.token)).expect(403);

    const res = await http(app).get("/users").set(bearer(admin.token)).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).not.toHaveProperty("passwordHash");
  });
});
