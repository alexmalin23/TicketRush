import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { HttpException, Inject, Injectable } from "../core";
import { PROVIDER_CONFIG, ProviderConfig } from "./config";
import { CreateChargeInput, MockOutcome } from "./charges.schemas";

export type ChargeStatus = "succeeded" | "declined";

export interface Charge {
  idempotencyKey: string;
  amountCents: number;
  status: ChargeStatus;
  providerRef: string;
  createdAt: Date;
}

/**
 * Stand-in for an external card processor. State lives in this process only: the provider runs
 * as a single instance, exactly like the one real provider every API instance would call.
 */
@Injectable()
export class ChargesService {
  /** Every charge ever decided, one entry per idempotency key: the source of truth for audits. */
  private readonly ledger = new Map<string, Charge>();
  /** Charges still being processed. A concurrent duplicate waits for the same outcome. */
  private readonly inFlight = new Map<string, Promise<Charge>>();

  constructor(@Inject(PROVIDER_CONFIG) private readonly config: ProviderConfig) {}

  /**
   * Idempotent by key: the first request decides the outcome; every later request with the same
   * key (sequential or concurrent) gets that same charge back and never moves money again.
   */
  async charge(input: CreateChargeInput, forced?: MockOutcome): Promise<Charge> {
    const existing = this.ledger.get(input.idempotencyKey);
    if (existing) return this.replay(existing, input);

    const pending = this.inFlight.get(input.idempotencyKey);
    if (pending) return this.replay(await pending, input);

    // Registered synchronously, before any await: a duplicate arriving during the latency below
    // finds this promise instead of starting a second charge.
    const processing = this.process(input, forced);
    this.inFlight.set(input.idempotencyKey, processing);
    try {
      return await processing;
    } finally {
      this.inFlight.delete(input.idempotencyKey);
    }
  }

  ledgerEntries(): Charge[] {
    return [...this.ledger.values()];
  }

  /** Clears the ledger between load runs. */
  reset(): void {
    this.ledger.clear();
  }

  private async process(input: CreateChargeInput, forced?: MockOutcome): Promise<Charge> {
    const { MOCK_PAYMENT_LATENCY_MS_MIN: min, MOCK_PAYMENT_LATENCY_MS_MAX: max } = this.config;
    await sleep(min + Math.floor(Math.random() * (max - min + 1)));

    const outcome = forced ?? this.randomOutcome();
    const charge: Charge = {
      idempotencyKey: input.idempotencyKey,
      amountCents: input.amountCents,
      status: outcome === "decline" ? "declined" : "succeeded",
      providerRef: `ch_${randomUUID()}`,
      createdAt: new Date(),
    };
    // Recorded before the response is sent: a client that times out does not know whether it was
    // charged, but the provider does. Only the same idempotency key can safely find out.
    this.ledger.set(charge.idempotencyKey, charge);

    if (outcome === "hang") await sleep(this.config.MOCK_PAYMENT_HANG_MS);
    return charge;
  }

  private randomOutcome(): MockOutcome {
    const roll = Math.random();
    if (roll < this.config.MOCK_PAYMENT_TIMEOUT_RATE) return "hang";
    if (roll < this.config.MOCK_PAYMENT_TIMEOUT_RATE + this.config.MOCK_PAYMENT_FAILURE_RATE) return "decline";
    return "succeed";
  }

  /** A replay must describe the same payment; reusing a key for another amount is a client bug. */
  private replay(charge: Charge, input: CreateChargeInput): Charge {
    if (charge.amountCents !== input.amountCents) {
      throw new HttpException(
        422,
        "Idempotency key already used for a different amount",
        { idempotencyKey: input.idempotencyKey, originalAmountCents: charge.amountCents },
        "IDEMPOTENCY_KEY_REUSED"
      );
    }
    return charge;
  }
}
