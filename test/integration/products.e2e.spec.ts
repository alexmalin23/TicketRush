import { ModexApplication } from "../../src/core";
import { bearer, createTestApp, createUser, http, insertProduct, resetDatabase } from "../helpers/test-app";

describe("Products (e2e)", () => {
  let app: ModexApplication;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    adminToken = (await createUser(app, "admin@example.com", "admin")).token;
    userToken = (await createUser(app, "user@example.com")).token;
  });
  afterAll(() => app.close());

  it("lists products publicly with pagination", async () => {
    for (const name of ["a", "b", "c"]) await insertProduct(app, { name, price: 10, stock: 1 });

    const res = await http(app).get("/products?limit=2&offset=1").expect(200);
    expect(res.body.map((p: { name: string }) => p.name)).toEqual(["b", "c"]);
    expect(res.body[0].price).toBe(10); // NUMERIC parsed to a number, not "10.00"
  });

  it("returns 404 for a missing product and 400 for a bad id", async () => {
    await http(app).get("/products/999").expect(404);
    await http(app).get("/products/abc").expect(400);
  });

  it("only admins can create", async () => {
    const body = { name: "Desk", price: 499.9, stock: 3 };
    await http(app).post("/products").send(body).expect(401);
    await http(app).post("/products").set(bearer(userToken)).send(body).expect(403);

    const res = await http(app).post("/products").set(bearer(adminToken)).send(body).expect(201);
    expect(res.body).toMatchObject({ id: 1, ...body });
  });

  it("rejects invalid products", async () => {
    const res = await http(app)
      .post("/products")
      .set(bearer(adminToken))
      .send({ name: "", price: -5, stock: 1.5 })
      .expect(400);
    expect(res.body.details).toHaveLength(3);
  });

  it("PATCH changes only the fields that were sent", async () => {
    const { id } = await insertProduct(app, { name: "Lamp", price: 80, stock: 4 });

    const res = await http(app).patch(`/products/${id}`).set(bearer(adminToken)).send({ price: 70 }).expect(200);
    expect(res.body).toMatchObject({ name: "Lamp", price: 70, stock: 4 });

    await http(app).patch(`/products/${id}`).set(bearer(adminToken)).send({}).expect(400);
    await http(app).patch("/products/999").set(bearer(adminToken)).send({ price: 1 }).expect(404);
  });

  it("DELETE returns 204, then the product is gone", async () => {
    const { id } = await insertProduct(app, { name: "Lamp", price: 80, stock: 4 });

    await http(app).delete(`/products/${id}`).set(bearer(adminToken)).expect(204);
    await http(app).get(`/products/${id}`).expect(404);
    await http(app).delete(`/products/${id}`).set(bearer(adminToken)).expect(404);
  });
});
