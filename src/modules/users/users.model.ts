import { Injectable } from "../../core";
import type { Role } from "../../common/types/auth-user";
import { Queryable } from "../../database/database.constants";
import { DatabaseService } from "../../database/database.service";

/** A user as it may be sent to clients: never includes the password hash. */
export interface User {
  id: number;
  email: string;
  role: Role;
  createdAt: Date;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

// Explicit column list: `SELECT *` would leak password_hash into responses.
const COLUMNS = `id, email, role, created_at AS "createdAt"`;

@Injectable()
export class UsersModel {
  constructor(private readonly database: DatabaseService) {}

  async findAll(db: Queryable = this.database): Promise<User[]> {
    const { rows } = await db.query<User>(`SELECT ${COLUMNS} FROM users ORDER BY id`);
    return rows;
  }

  async findById(id: number, db: Queryable = this.database): Promise<User | null> {
    const { rows } = await db.query<User>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** The only method that returns the hash; used by login. */
  async findByEmailWithPassword(email: string, db: Queryable = this.database): Promise<UserWithPassword | null> {
    const { rows } = await db.query<UserWithPassword>(
      `SELECT ${COLUMNS}, password_hash AS "passwordHash" FROM users WHERE email = $1`,
      [email]
    );
    return rows[0] ?? null;
  }

  async create(
    data: { email: string; passwordHash: string; role?: Role },
    db: Queryable = this.database
  ): Promise<User> {
    const { rows } = await db.query<User>(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [data.email, data.passwordHash, data.role ?? "user"]
    );
    return rows[0];
  }
}
