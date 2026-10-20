import { ConflictException, Injectable, NotFoundException } from "../../core";
import type { AuthUser } from "../../common/types/auth-user";
import { DatabaseService } from "../../database/database.service";
import { ProductsModel } from "../products/products.model";
import { Order, OrderItem, OrdersModel } from "./orders.model";
import { CreateOrderInput } from "./orders.schemas";

/**
 * The transaction example: placing an order touches two Models
 * (products stock + orders), and it must be all-or-nothing.
 * The Service owns the transaction and passes the same `client` to every Model call.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ordersModel: OrdersModel,
    private readonly productsModel: ProductsModel
  ) {}

  create(userId: number, input: CreateOrderInput): Promise<Order> {
    return this.database.transaction(async (client) => {
      // 1. Lock the products. A concurrent order for the same product waits here
      //    until we commit, then sees the updated stock.
      const ids = input.items.map((item) => item.productId);
      const products = await this.productsModel.findByIdsForUpdate(ids, client);
      const byId = new Map(products.map((product) => [product.id, product]));

      // 2. Business rules. Throwing here rolls everything back.
      const items: OrderItem[] = input.items.map(({ productId, quantity }) => {
        const product = byId.get(productId);
        if (!product) {
          throw new NotFoundException(`Product ${productId} not found`);
        }
        if (product.stock < quantity) {
          throw new ConflictException(`Not enough stock for "${product.name}"`, {
            productId,
            available: product.stock,
            requested: quantity,
          });
        }
        return { productId, quantity, unitPrice: product.price };
      });

      // 3. Writes, all on the same client = the same transaction.
      for (const item of items) {
        await this.productsModel.decrementStock(item.productId, item.quantity, client);
      }

      // Sum in agorot/cents to avoid floating point errors (0.1 + 0.2 !== 0.3).
      const totalCents = items.reduce(
        (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
        0
      );
      const order = await this.ordersModel.create(userId, totalCents / 100, client);
      await this.ordersModel.addItems(order.id, items, client);

      return { ...order, items };
    });
  }

  findMine(userId: number): Promise<Order[]> {
    return this.ordersModel.findByUser(userId);
  }

  /** Users see only their own orders; admins see all. Others get 404, not 403, so ids do not leak. */
  async findOne(id: number, user: AuthUser): Promise<Order> {
    const order = await this.ordersModel.findById(id);
    if (!order || (order.userId !== user.id && user.role !== "admin")) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return order;
  }
}
