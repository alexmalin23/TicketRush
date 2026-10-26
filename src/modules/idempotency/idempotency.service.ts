import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, HttpException, Injectable, toErrorBody } from "../../core";
import { IdempotencyModel } from "./idempotency.model";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/** Keys are kept 24 hours; after that the same key starts a new request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** What a protected operation answered: replayed byte-for-byte to every retry with the same key. */
export interface StoredResponse<T = unknown> {
  status: number;
  body: T;
}

/** Same JSON regardless of key order, so {a,b} and {b,a} are the same request. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashRequest(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

/** The Idempotency-Key header, required and bounded (it is stored and compared). */
export function requireIdempotencyKey(header: string | undefined): string {
  const key = header?.trim();
  if (!key || key.length > 255) {
    throw new BadRequestException(
      "Idempotency-Key header is required (1-255 characters)",
      [{ path: "headers.idempotency-key", message: "Required, 1-255 characters" }],
      "VALIDATION_ERROR"
    );
  }
  return key;
}

/**
 * Runs an operation at most once per (user, key). Retries with the same key and body get the
 * stored response; a different body is rejected; a retry while the first attempt still runs is told
 * to wait. Explicit by design: the route that needs it calls runOnce(), nothing is intercepted silently.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly model: IdempotencyModel) {}

  async runOnce<T>(
    userId: number,
    key: string,
    body: unknown,
    operation: () => Promise<StoredResponse<T>>
  ): Promise<StoredResponse> {
    const requestHash = hashRequest(body);

    // Saving the key IS the check: of any number of simultaneous requests, exactly one gets true.
    const isFirstAttempt = await this.model.saveKeyIfNew(userId, key, requestHash);
    if (!isFirstAttempt) return this.answerRetry(userId, key, requestHash, body, operation);

    return this.runAndStore(userId, key, operation);
  }

  /** The key already exists: decide what a repeated request gets. */
  private async answerRetry<T>(
    userId: number,
    key: string,
    requestHash: string,
    body: unknown,
    operation: () => Promise<StoredResponse<T>>
  ): Promise<StoredResponse> {
    const existing = await this.model.findKey(userId, key);

    const expired = existing && Date.now() - existing.createdAt.getTime() > IDEMPOTENCY_TTL_MS;
    if (!existing || expired) {
      // Deleted or expired since we looked: start over (again, exactly one concurrent caller wins).
      await this.model.deleteKey(userId, key);
      return this.runOnce(userId, key, body, operation);
    }

    if (existing.requestHash !== requestHash) {
      throw new HttpException(422, "Idempotency-Key was already used with a different request", { key }, "IDEMPOTENCY_KEY_REUSED");
    }
    if (existing.state === "in_progress") {
      throw new ConflictException("A request with this Idempotency-Key is still in progress", { key }, "IDEMPOTENCY_IN_PROGRESS");
    }
    return { status: existing.responseCode!, body: existing.responseBody };
  }

  /** First attempt: run the operation and store what it answered, so retries can replay it. */
  private async runAndStore<T>(
    userId: number,
    key: string,
    operation: () => Promise<StoredResponse<T>>
  ): Promise<StoredResponse> {
    let response: StoredResponse;
    try {
      response = await operation();
    } catch (error) {
      if (!(error instanceof HttpException) || error.statusCode >= 500) {
        // Crash or outage: there is no answer to stand by, so free the key and let a retry run again.
        await this.model.deleteKey(userId, key);
        throw error;
      }
      // A business answer (seat taken, card declined) is the outcome: retries must see it again.
      response = { status: error.statusCode, body: toErrorBody(error) };
    }
    await this.model.saveResponse(userId, key, response.status, response.body);
    return response;
  }
}
