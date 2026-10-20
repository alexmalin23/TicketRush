import { ModexApplication } from "../../src/core";
import { DatabaseService } from "../../src/database/database.service";
import { bearer, createTestApp, createUser, http, insertProduct, resetDatabase } from "../helpers/test-app";

describe("Orders (e2e) - transactions", () => {
  let app: ModexApplication;
  let token: string;

  const stockOf = async (id: number) =>
    (await app.get(DatabaseService).query<{ stock: number }>("SELECT stock FROM products WHERE id = $1", [id]))
      .rows[0].stock;
  const orderCount = async () =>
    Number((await app.get(DatabaseService).query<{ count: string }>("SELECT count(*) FROM orders")).rows[0].count);

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    token = (await createUser(app, "buyer@example.com")).token;
  });
  afterAll(() => app.close());

  it("creates an order, computes the total and decrements stock", async () => {
    const pen = await insertProduct(app, { name: "Pen", price: 0.1, stock: 10 });
    const book = await insertProduct(app, { name: "Book", price: 0.2, stock: 5 });

    const res = await http(app)
      .post("/orders")
      .set(bearer(token))
      .send({ items: [{ productId: pen.id, quantity: 3 }, { productId: book.id, quantity: 1 }] })
      .expect(201);

    expect(res.body.total).toBe(0.5); // 0.3 + 0.2, computed in cents: no 0.5000000001
    expect(res.body.items).toHaveLength(2);
    expect(await stockOf(pen.id)).toBe(7);
    expect(await stockOf(book.id)).toBe(4);
  });

  it("rolls back everything when one item has no stock", async () => {
    const pen = await insertProduct(app, { name: "Pen", price: 1, stock: 10 });
    const book = await insertProduct(app, { name: "Book", price: 2, stock: 1 });

    const res = await http(app)
      .post("/orders")
      .set(bearer(token))
      .send({ items: [{ productId: pen.id, quantity: 2 }, { productId: book.id, quantity: 5 }] })
      .expect(409);

    expect(res.body.details).toEqual({ productId: book.id, available: 1, requested: 5 });
    expect(await stockOf(pen.id)).toBe(10);
    expect(await orderCount()).toBe(0);
  });

  it("returns 404 for an unknown product and 400 for duplicates", async () => {
    const pen = await insertProduct(app, { name: "Pen", price: 1, stock: 10 });
    await http(app).post("/orders").set(bearer(token)).send({ items: [{ productId: 999, quantity: 1 }] }).expect(404);
    await http(app)
      .post("/orders")
      .set(bearer(token))
      .send({ items: [{ productId: pen.id, quantity: 1 }, { productId: pen.id, quantity: 1 }] })
      .expect(400);
  });

  it("never oversells under concurrent orders (row locks)", async () => {
    const last = await insertProduct(app, { name: "Last items", price: 5, stock: 3 });

    // 8 buyers hit "buy" at the same moment for a product with 3 left.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        http(app).post("/orders").set(bearer(token)).send({ items: [{ productId: last.id, quantity: 1 }] })
      )
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    expect(await stockOf(last.id)).toBe(0);
    expect(await orderCount()).toBe(3);
  });

  it("users see only their own orders; admins see any", async () => {
    const pen = await insertProduct(app, { name: "Pen", price: 1, stock: 10 });
    const order = await http(app)
      .post("/orders")
      .set(bearer(token))
      .send({ items: [{ productId: pen.id, quantity: 1 }] })
      .expect(201);

    const other = await createUser(app, "other@example.com");
    const admin = await createUser(app, "admin@example.com", "admin");

    await http(app).get(`/orders/${order.body.id}`).set(bearer(token)).expect(200);
    await http(app).get(`/orders/${order.body.id}`).set(bearer(other.token)).expect(404);
    await http(app).get(`/orders/${order.body.id}`).set(bearer(admin.token)).expect(200);

    const mine = await http(app).get("/orders").set(bearer(token)).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].items).toEqual([{ productId: pen.id, quantity: 1, unitPrice: 1 }]);
    await http(app).get("/orders").set(bearer(other.token)).expect(200, []);
  });
});
