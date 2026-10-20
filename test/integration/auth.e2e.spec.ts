import jwt from "jsonwebtoken";
import { ModexApplication } from "../../src/core";
import { bearer, createTestApp, createUser, http, resetDatabase } from "../helpers/test-app";

describe("Auth & Users (e2e)", () => {
  let app: ModexApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(() => resetDatabase(app));
  afterAll(() => app.close());

  it("registers a user, normalizes the email and never returns the password", async () => {
    const res = await http(app)
      .post("/auth/register")
      .send({ email: "  Dana@Example.COM ", password: "password123" })
      .expect(201);

    expect(res.body.user).toMatchObject({ id: 1, email: "dana@example.com", role: "user" });
    expect(res.body.user).not.toHaveProperty("passwordHash");
    expect(typeof res.body.accessToken).toBe("string");
  });

  it("rejects a duplicate email with 409", async () => {
    await createUser(app, "dana@example.com");
    await http(app)
      .post("/auth/register")
      .send({ email: "DANA@example.com", password: "password123" })
      .expect(409);
  });

  it("validates the registration body", async () => {
    const res = await http(app).post("/auth/register").send({ email: "nope", password: "123" }).expect(400);
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(["body.email", "body.password"]);
  });

  it("logs in with the right password only", async () => {
    await createUser(app, "dana@example.com", "user", "password123");
    await http(app).post("/auth/login").send({ email: "dana@example.com", password: "password123" }).expect(200);
    await http(app).post("/auth/login").send({ email: "dana@example.com", password: "wrong-pass" }).expect(401);
    await http(app).post("/auth/login").send({ email: "ghost@example.com", password: "password123" }).expect(401);
  });

  it("GET /auth/me requires a valid token", async () => {
    const { token } = await createUser(app, "dana@example.com");

    const me = await http(app).get("/auth/me").set(bearer(token)).expect(200);
    expect(me.body.email).toBe("dana@example.com");

    await http(app).get("/auth/me").expect(401);
    await http(app).get("/auth/me").set(bearer("not-a-jwt")).expect(401);

    // Correct shape, wrong secret: a forged admin token must not work
    const forged = jwt.sign({ email: "x", role: "admin" }, "attacker-secret-1234567", { subject: "1" });
    await http(app).get("/auth/me").set(bearer(forged)).expect(401);
  });

  it("/users is admin only", async () => {
    const user = await createUser(app, "user@example.com");
    const admin = await createUser(app, "admin@example.com", "admin");

    await http(app).get("/users").expect(401);
    await http(app).get("/users").set(bearer(user.token)).expect(403);

    const res = await http(app).get("/users").set(bearer(admin.token)).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).not.toHaveProperty("passwordHash");
  });
});
