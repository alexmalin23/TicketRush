import jwt from "jsonwebtoken";
import { ModexApplication } from "../../src/core";
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
