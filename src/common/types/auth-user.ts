export type Role = "user" | "admin";

/** The logged-in user, as decoded from the JWT by AuthGuard. */
export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}

// Adds `req.user` to Express's Request type for the whole project.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
