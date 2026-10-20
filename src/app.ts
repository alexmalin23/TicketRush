import { defineApp } from "./core";
import { envProvider } from "./config/env";
import { poolProvider } from "./database/database.providers";
import { AuthController } from "./modules/auth/auth.controller";
import { OrdersController } from "./modules/orders/orders.controller";
import { ProductsController } from "./modules/products/products.controller";
import { UsersController } from "./modules/users/users.controller";

/**
 * The whole application in one place.
 *
 * - controllers: adding a feature = write its controller/service/model, add the controller here.
 *   Services and Models are created automatically from the constructors (@Injectable).
 * - providers: only things that are not our own classes (validated env, the pg Pool).
 */
export const appDefinition = defineApp({
  controllers: [ProductsController, UsersController, AuthController, OrdersController],
  providers: [envProvider, poolProvider],
});
