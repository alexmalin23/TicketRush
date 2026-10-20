import { SetMetadata } from "../../core";
import type { Role } from "../types/auth-user";

export const ROLES_KEY = "app:roles";

/** @Roles("admin"): only these roles may call the route. Enforced by RolesGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
