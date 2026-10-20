import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/**
 * A well-formed hash that matches no password. Login verifies against it when the
 * email does not exist, so "unknown email" and "wrong password" take the same time
 * and an attacker cannot use response time to find registered emails.
 */
export const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(KEY_LENGTH)}`;

/** Hashes with scrypt (built into Node, no native deps) and a random salt: "scrypt$<salt>$<key>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltHex, keyHex] = stored.split("$");
  if (algorithm !== "scrypt" || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  // Constant-time comparison: does not leak how many bytes matched.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
