import { defineApp } from "./core";
import { envProvider } from "./config/env";
import { poolProvider, replicaPoolProvider } from "./database/database.providers";
import { redisProvider } from "./database/redis.providers";
import { AuthController } from "./modules/auth/auth.controller";
import { DevController } from "./modules/dev/dev.controller";
import { EventsController } from "./modules/events/events.controller";
import { HoldsController } from "./modules/holds/holds.controller";
import { holdStoreProvider } from "./modules/holds/hold-store";
import { OrdersController } from "./modules/orders/orders.controller";
import { HealthController } from "./modules/health/health.controller";
import { UsersController } from "./modules/users/users.controller";
import { WaitingRoomController } from "./modules/waiting-room/waiting-room.controller";

/**
 * The whole application in one place.
 *
 * - controllers: adding a feature = write its controller/service/model, add the controller here.
 *   Services and Models are created automatically from the constructors (@Injectable).
 * - providers: only things that are not our own classes (validated env, the pg Pool, Redis), and
 *   choices made once at startup (where holds live).
 */
export const appDefinition = defineApp({
  controllers: [HealthController, UsersController, AuthController, EventsController, HoldsController, OrdersController, WaitingRoomController, DevController],
  providers: [envProvider, poolProvider, replicaPoolProvider, redisProvider, holdStoreProvider],
});
